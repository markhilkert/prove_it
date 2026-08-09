/**
 * Signal lifecycle: one explicit signal authorizes one Stop cycle.
 *
 * The dispatcher snapshots the active signal at entry, evaluates every
 * `when.signal` in that dispatch against the snapshot, and clears the
 * persisted signal at the first launch whose eligibility actually depended
 * on it. So a single `prove_it signal done` still fires a whole batch of
 * signal-gated tasks in one Stop, but a later Stop—including one reached by
 * remediating a blocked Stop—finds nothing persisted and cannot relaunch
 * expensive agent work without a fresh signal.
 */
const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const {
  invokeHook, createTempDir, cleanupTempDir, initGitRepo,
  writeConfig, makeConfig, isolatedEnv
} = require('./hook-harness')
const { setSignal, getSignal, setPhase, getPhase, getFileEdits, getAsyncDir } = require('../../lib/session')

/** A script task that records its launch by appending to a file. */
function marker (dir, name) {
  return path.join(dir, `${name}.marker`)
}

function markerTask (dir, name, extra = {}) {
  return {
    name,
    type: 'script',
    command: `sh -c 'echo ran >> ${marker(dir, name)}'`,
    ...extra
  }
}

function launchCount (dir, name) {
  try {
    return fs.readFileSync(marker(dir, name), 'utf8').trim().split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

function launched (dir, name) {
  return launchCount(dir, name) > 0
}

/** A sync script task that fails, blocking the Stop before its clean tail. */
function blockerTask (name = 'blocker', pass = false) {
  return { name, type: 'script', command: `sh -c 'exit ${pass ? 0 : 1}'` }
}

/**
 * A reviewer fixture that captures the prompt it receives on stdin.
 * The shared reviewerFixtures() helpers discard stdin, so a forked reviewer's
 * expanded {{signal_message}} would be unobservable.
 */
function writeCaptureReviewer (dir, name) {
  const capturePath = path.join(dir, `${name}.stdin`)
  const reviewerPath = path.join(dir, `${name}.sh`)
  fs.writeFileSync(reviewerPath, `#!/usr/bin/env bash\ncat > "${capturePath}"\necho "PASS"\n`)
  fs.chmodSync(reviewerPath, 0o755)
  return { reviewerPath, capturePath }
}

function readLog (proveItDir, sessionId) {
  const p = path.join(proveItDir, 'sessions', `${sessionId}.jsonl`)
  try {
    return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  } catch {
    return []
  }
}

describe('signal lifecycle — one signal authorizes one Stop cycle', () => {
  let tmpDir, projectDir, env, origProveItDir, origHome

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_siglife_')
    projectDir = path.join(tmpDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    initGitRepo(projectDir)
    env = isolatedEnv(tmpDir)

    origProveItDir = process.env.PROVE_IT_DIR
    origHome = process.env.HOME
    process.env.PROVE_IT_DIR = env.PROVE_IT_DIR
    process.env.HOME = env.HOME
  })

  afterEach(() => {
    if (origProveItDir === undefined) delete process.env.PROVE_IT_DIR
    else process.env.PROVE_IT_DIR = origProveItDir
    process.env.HOME = origHome
    cleanupTempDir(tmpDir)
  })

  function stop (sessionId) {
    return invokeHook('claude:Stop', { session_id: sessionId }, { projectDir, env, cwd: projectDir })
  }

  // ── 1 ── Same-cycle batching: one signal, several gated tasks.
  // The blocker is what makes this falsifiable: it stops the dispatcher before
  // the clean-Stop tail, so any observed clear must come from clear-on-launch.
  it('runs every signal-gated task in the authorized cycle and consumes the signal once', () => {
    setSignal('sl-batch', 'done', null)
    writeConfig(projectDir, makeConfig({
      claude: {
        Stop: [
          markerTask(projectDir, 'gated-a', { when: { signal: 'done' } }),
          markerTask(projectDir, 'gated-b', { when: { signal: 'done' } }),
          blockerTask()
        ]
      }
    }))

    stop('sl-batch')

    assert.ok(launched(projectDir, 'gated-a'), 'first gated task should launch')
    assert.ok(launched(projectDir, 'gated-b'),
      'second gated task should still launch from the dispatch-local snapshot after the signal was consumed')
    assert.strictEqual(getSignal('sl-batch'), null,
      'the authorization should be spent even though the Stop was blocked before its clean tail')
  })

  // ── 2 ── The incident: remediation after a blocked Stop must not re-buy review.
  it('does not relaunch gated work on the next Stop without a fresh signal', () => {
    setSignal('sl-once', 'done', null)
    writeConfig(projectDir, makeConfig({
      claude: {
        Stop: [
          markerTask(projectDir, 'gated-a', { when: { signal: 'done' } }),
          markerTask(projectDir, 'gated-b', { when: { signal: 'done' } }),
          blockerTask()
        ]
      }
    }))

    stop('sl-once')
    assert.strictEqual(launchCount(projectDir, 'gated-a'), 1, 'precondition: launched once')

    stop('sl-once')

    assert.strictEqual(launchCount(projectDir, 'gated-a'), 1, 'gated task must not relaunch on the next Stop')
    assert.strictEqual(launchCount(projectDir, 'gated-b'), 1, 'gated task must not relaunch on the next Stop')
  })

  // ── 3 ── The snapshot has to reach forked workers, which re-expand templates
  // in a child process after the persisted signal is already gone.
  it('delivers {{signal_message}} to a forked reviewer after the signal is consumed', async () => {
    setSignal('sl-fork', 'done', 'CANARY-SIGNAL-MESSAGE-7391')
    const { reviewerPath, capturePath } = writeCaptureReviewer(tmpDir, 'capture')

    writeConfig(projectDir, makeConfig({
      claude: {
        Stop: [
          {
            name: 'forked-review',
            type: 'agent',
            parallel: true,
            command: reviewerPath,
            prompt: 'Signal said: {{signal_message}}',
            when: { signal: 'done' }
          }
        ]
      }
    }))

    stop('sl-fork')

    assert.ok(fs.existsSync(capturePath), 'forked reviewer should have been invoked')
    const captured = fs.readFileSync(capturePath, 'utf8')
    assert.ok(captured.includes('CANARY-SIGNAL-MESSAGE-7391'),
      `forked reviewer should receive the snapshotted signal message, got:\n${captured}`)
    assert.strictEqual(getSignal('sl-fork'), null, 'signal should be consumed')
  })

  // ── 3b ── {{phase}} has the same hazard as {{signal_message}}: consuming a
  // `done` resets the persisted phase, and the forked worker re-expands its
  // prompt afterwards, in its own process.
  it('delivers the pre-consumption {{phase}} to a forked reviewer', () => {
    setSignal('sl-fork-phase', 'done', null)
    setPhase('sl-fork-phase', 'implement')
    const { reviewerPath, capturePath } = writeCaptureReviewer(tmpDir, 'capture-phase')

    writeConfig(projectDir, makeConfig({
      claude: {
        Stop: [
          {
            name: 'forked-review',
            type: 'agent',
            parallel: true,
            command: reviewerPath,
            prompt: 'Phase was: {{phase}}',
            when: { signal: 'done' }
          }
        ]
      }
    }))

    stop('sl-fork-phase')

    assert.ok(fs.existsSync(capturePath), 'forked reviewer should have been invoked')
    const captured = fs.readFileSync(capturePath, 'utf8')
    assert.ok(/Phase was: implement/.test(captured),
      `forked reviewer should see the phase the dispatch started with, got:\n${captured}`)
    assert.strictEqual(getPhase('sl-fork-phase'), 'unknown', 'the persisted phase was reset by consumption')
  })

  // ── 4 ── Closest shape to the real runaway: paid parallel work launches,
  // an earlier-exiting sync sibling blocks, and its result is never settled.
  it('consumes the signal for parallel work that launches but is never settled', () => {
    setSignal('sl-unsettled', 'done', null)
    writeConfig(projectDir, makeConfig({
      claude: {
        Stop: [
          markerTask(projectDir, 'paid-review', { parallel: true, when: { signal: 'done' } }),
          blockerTask()
        ]
      }
    }))

    const first = stop('sl-unsettled')
    assert.strictEqual(getSignal('sl-unsettled'), null,
      'launching paid parallel work spends the authorization even when its result is never settled')
    assert.ok(first.stdout.includes('blocker'), 'precondition: the Stop was blocked by the sibling')

    stop('sl-unsettled')
    const skips = readLog(env.PROVE_IT_DIR, 'sl-unsettled')
      .filter(e => e.reviewer === 'paid-review' && e.status === 'SKIP')
    assert.ok(skips.some(e => /signal "done" is not active/.test(e.reason || '')),
      'the second Stop must skip the paid review for want of an active signal')
  })

  // ── 5 ── A launched reviewer that SKIPs still cost a launch.
  it('keeps the signal consumed when the launched reviewer SKIPs', () => {
    setSignal('sl-skip', 'done', null)
    const skipReviewer = path.join(tmpDir, 'skip.sh')
    fs.writeFileSync(skipReviewer, '#!/usr/bin/env bash\ncat > /dev/null\necho "SKIP: unrelated"\n')
    fs.chmodSync(skipReviewer, 0o755)

    writeConfig(projectDir, makeConfig({
      claude: {
        Stop: [
          { name: 'skipping-review', type: 'agent', command: skipReviewer, prompt: 'Review this', when: { signal: 'done' } },
          blockerTask()
        ]
      }
    }))

    stop('sl-skip')

    assert.strictEqual(getSignal('sl-skip'), null, 'a reviewer that ran and SKIPped still spent the authorization')
  })

  // ── 6 ── Not eager: entering Stop with a signal is not enough to spend it.
  it('leaves the signal armed when the gated task\'s when does not pass', () => {
    setSignal('sl-unmet', 'done', null)
    writeConfig(projectDir, makeConfig({
      claude: {
        Stop: [
          markerTask(projectDir, 'gated-a', { when: { signal: 'done', fileExists: 'absent.txt' } }),
          blockerTask()
        ]
      }
    }))

    stop('sl-unmet')

    assert.ok(!launched(projectDir, 'gated-a'), 'gated task should not launch')
    const signal = getSignal('sl-unmet')
    assert.notStrictEqual(signal, null, 'signal must stay armed when nothing it authorizes ran')
    assert.strictEqual(signal.type, 'done')
  })

  // ── 7 ── An ungated blocker that fires first spends nothing.
  it('leaves the signal armed when an ungated task blocks before gated work', () => {
    setSignal('sl-early-block', 'done', null)
    writeConfig(projectDir, makeConfig({
      claude: {
        Stop: [
          blockerTask(),
          markerTask(projectDir, 'gated-a', { when: { signal: 'done' } })
        ]
      }
    }))

    stop('sl-early-block')

    assert.ok(!launched(projectDir, 'gated-a'), 'gated task is never reached')
    assert.notStrictEqual(getSignal('sl-early-block'), null, 'signal must stay armed')
  })

  // ── 8 ── A gated task that ran and failed still spent the authorization.
  it('consumes the signal when the gated task itself fails', () => {
    setSignal('sl-gated-fail', 'done', null)
    writeConfig(projectDir, makeConfig({
      claude: {
        Stop: [
          { name: 'gated-blocker', type: 'script', command: "sh -c 'exit 1'", when: { signal: 'done' } }
        ]
      }
    }))

    stop('sl-gated-fail')

    assert.strictEqual(getSignal('sl-gated-fail'), null,
      'the task ran and may have cost money; a fresh review requires a fresh signal')
  })

  // ── 9 ── OR provenance: a signal-free clause that passes on its own means
  // the task was eligible without the signal, so the signal is not spent.
  it('does not consume the signal when a signal-free OR clause independently passes', () => {
    setSignal('sl-or-free', 'done', null)
    fs.writeFileSync(path.join(projectDir, 'trigger.txt'), 'x')
    writeConfig(projectDir, makeConfig({
      claude: {
        Stop: [
          markerTask(projectDir, 'or-task', { when: [{ signal: 'done' }, { fileExists: 'trigger.txt' }] }),
          blockerTask()
        ]
      }
    }))

    stop('sl-or-free')

    assert.ok(launched(projectDir, 'or-task'), 'task should launch via the signal-free route')
    const signal = getSignal('sl-or-free')
    assert.notStrictEqual(signal, null, 'an unrelated active signal must not be consumed by a task that did not need it')
    assert.strictEqual(signal.type, 'done')
  })

  // ── 10 ── OR provenance: signal-bearing clause is the only passing route.
  it('consumes the signal when the signal clause is the only passing OR route', () => {
    setSignal('sl-or-signal', 'done', null)
    writeConfig(projectDir, makeConfig({
      claude: {
        Stop: [
          markerTask(projectDir, 'or-task', { when: [{ signal: 'done' }, { fileExists: 'absent.txt' }] }),
          blockerTask()
        ]
      }
    }))

    stop('sl-or-signal')

    assert.ok(launched(projectDir, 'or-task'), 'task should launch via the signal route')
    assert.strictEqual(getSignal('sl-or-signal'), null, 'the signal was the only thing that made it eligible')
  })

  // ── 11 ── Async: consuming at spawn is what prevents a duplicate spawn on
  // the Stop that harvests the first result.
  it('consumes the signal when an async task spawns and cannot spawn a duplicate later', async () => {
    setSignal('sl-async', 'done', null)
    writeConfig(projectDir, makeConfig({
      claude: {
        Stop: [
          markerTask(projectDir, 'async-review', { async: true, when: { signal: 'done' } }),
          blockerTask()
        ]
      }
    }))

    stop('sl-async')
    assert.strictEqual(getSignal('sl-async'), null, 'spawning the async task spends the authorization')

    // Wait for the detached worker to write its result.
    const asyncDir = getAsyncDir('sl-async')
    const resultPath = path.join(asyncDir, 'async-review.json')
    for (let i = 0; i < 100 && !fs.existsSync(resultPath); i++) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.ok(fs.existsSync(resultPath), 'async worker should have written a result')
    assert.strictEqual(launchCount(projectDir, 'async-review'), 1, 'precondition: spawned once')

    writeConfig(projectDir, makeConfig({
      claude: { Stop: [markerTask(projectDir, 'async-review', { async: true, when: { signal: 'done' } })] }
    }))
    stop('sl-async')

    assert.ok(!fs.existsSync(resultPath), 'the pending result should have been harvested')
    assert.strictEqual(launchCount(projectDir, 'async-review'), 1, 'no duplicate spawn without a fresh signal')
  })

  // ── 12 ── `done` still resets the phase even though the tail can no longer
  // read the signal from persisted state.
  it('resets the phase to unknown after a consumed done authorization', () => {
    setSignal('sl-phase', 'done', null)
    setPhase('sl-phase', 'implement')
    writeConfig(projectDir, makeConfig({
      claude: { Stop: [markerTask(projectDir, 'gated-a', { when: { signal: 'done' } })] }
    }))

    stop('sl-phase')

    assert.ok(launched(projectDir, 'gated-a'), 'precondition: the gated task ran')
    assert.strictEqual(getPhase('sl-phase'), 'unknown',
      'done must still reset the phase after early consumption')
  })

  // ── 12b ── The phase transition belongs to consumption, not to settlement.
  // A blocked Stop exits long before the clean tail, so a tail-only reset
  // strands the phase forever: the authorization is already gone, so no later
  // Stop can ever reach the reset either.
  it('resets the phase to unknown even when the authorized task fails and blocks the Stop', () => {
    setSignal('sl-phase-block', 'done', null)
    setPhase('sl-phase-block', 'implement')
    writeConfig(projectDir, makeConfig({
      claude: {
        Stop: [
          { name: 'gated-blocker', type: 'script', command: "sh -c 'exit 1'", when: { signal: 'done' } }
        ]
      }
    }))

    stop('sl-phase-block')

    assert.strictEqual(getSignal('sl-phase-block'), null, 'precondition: the authorization was consumed')
    assert.strictEqual(getPhase('sl-phase-block'), 'unknown',
      'a consumed done must not strand the phase when the Stop blocks')
  })

  // ── 12c ── Same, via the other post-consumption early exit: a parallel
  // batch whose settlement blocks after the loop.
  it('resets the phase to unknown when blocked parallel settlement exits the Stop', () => {
    setSignal('sl-phase-par', 'done', null)
    setPhase('sl-phase-par', 'implement')
    writeConfig(projectDir, makeConfig({
      claude: {
        Stop: [
          { name: 'gated-par', type: 'script', parallel: true, command: "sh -c 'exit 1'", when: { signal: 'done' } }
        ]
      }
    }))

    stop('sl-phase-par')

    assert.strictEqual(getSignal('sl-phase-par'), null, 'precondition: the authorization was consumed')
    assert.strictEqual(getPhase('sl-phase-par'), 'unknown',
      'a consumed done must not strand the phase when parallel settlement blocks')
  })

  // ── 12d ── Only `done` carries the phase reset. A consumed `stuck` must
  // leave the phase alone, exactly as the clean tail already does.
  it('does not reset the phase when the consumed signal is stuck', () => {
    setSignal('sl-phase-stuck', 'stuck', null)
    setPhase('sl-phase-stuck', 'implement')
    writeConfig(projectDir, makeConfig({
      claude: {
        Stop: [
          { name: 'stuck-gated', type: 'script', command: "sh -c 'exit 1'", when: { signal: 'stuck' } }
        ]
      }
    }))

    stop('sl-phase-stuck')

    assert.strictEqual(getSignal('sl-phase-stuck'), null, 'precondition: the stuck authorization was consumed')
    assert.strictEqual(getPhase('sl-phase-stuck'), 'implement', 'only done resets the phase')
  })

  // ── 12e ── Control for the phase snapshot. Resetting the phase mid-loop
  // must not change what the rest of the dispatch is eligible for: `when.phase`
  // is evaluated inside the task loop, and today no reachable Stop path can
  // change the phase mid-dispatch. That invariant has to survive the fix.
  it('control: a later phase-gated task still sees the phase the dispatch started with', () => {
    setSignal('sl-phase-mid', 'done', null)
    setPhase('sl-phase-mid', 'implement')
    writeConfig(projectDir, makeConfig({
      claude: {
        Stop: [
          markerTask(projectDir, 'gated-a', { when: { signal: 'done' } }),
          markerTask(projectDir, 'phase-gated', { when: { phase: 'implement' } }),
          blockerTask()
        ]
      }
    }))

    stop('sl-phase-mid')

    assert.ok(launched(projectDir, 'gated-a'), 'precondition: the done-gated task consumed the signal')
    assert.ok(launched(projectDir, 'phase-gated'),
      'the phase-gated task must still run: consumption changes persisted state, not this dispatch\'s view')
  })

  // ── 13 ── Characterization only. turnEdits is deliberately out of scope for
  // this patch; this pins today's behaviour so the fix cannot change it by
  // accident. A later change may legitimately invert this assertion.
  it('characterization: turn edits survive a blocked Stop (unchanged by this patch)', () => {
    writeConfig(projectDir, makeConfig({
      claude: { PreToolUse: [], Stop: [blockerTask()] }
    }))
    fs.writeFileSync(path.join(projectDir, 'edited.js'), 'x')

    invokeHook('claude:PreToolUse', {
      session_id: 'sl-turnedits',
      tool_name: 'Write',
      tool_input: { file_path: path.join(projectDir, 'edited.js'), content: 'x' }
    }, { projectDir, env, cwd: projectDir })

    assert.ok(getFileEdits('sl-turnedits')?.files.length > 0, 'precondition: the edit was recorded')

    stop('sl-turnedits')

    assert.ok(getFileEdits('sl-turnedits')?.files.length > 0,
      'turn edits still survive a blocked Stop today')
  })

  // ── 14 ── Eligibility is not a launch. When the fork mechanism fails before
  // it can create a worker, nothing was bought and the authorization survives.
  it('leaves the signal armed when the parallel fork fails before creating a worker', () => {
    setSignal('sl-nolaunch', 'done', null)

    // Block the session's async dir with a regular file: buildTaskSnapshot's
    // ensureDir then throws (EEXIST) before fork() is ever reached.
    const asyncDir = getAsyncDir('sl-nolaunch')
    fs.mkdirSync(path.dirname(asyncDir), { recursive: true })
    fs.writeFileSync(asyncDir, 'not a directory')

    writeConfig(projectDir, makeConfig({
      claude: {
        Stop: [markerTask(projectDir, 'paid-review', { parallel: true, when: { signal: 'done' } })]
      }
    }))

    const result = stop('sl-nolaunch')

    assert.strictEqual(result.exitCode, 1, 'precondition: the fork failed and the dispatch errored out')
    assert.ok(!launched(projectDir, 'paid-review'), 'no worker should have run')
    const signal = getSignal('sl-nolaunch')
    assert.notStrictEqual(signal, null, 'a launch that never happened must not spend the authorization')
    assert.strictEqual(signal.type, 'done')
  })

  // ── 14b ── Same boundary on the async path. spawnAsyncTask returns nothing
  // and so cannot report declining, but it shares buildTaskSnapshot and
  // therefore the same pre-spawn failure.
  it('leaves the signal armed when the async spawn fails before creating a worker', () => {
    setSignal('sl-nolaunch-async', 'done', null)

    const asyncDir = getAsyncDir('sl-nolaunch-async')
    fs.mkdirSync(path.dirname(asyncDir), { recursive: true })
    fs.writeFileSync(asyncDir, 'not a directory')

    writeConfig(projectDir, makeConfig({
      claude: {
        Stop: [markerTask(projectDir, 'async-review', { async: true, when: { signal: 'done' } })]
      }
    }))

    const result = stop('sl-nolaunch-async')

    assert.strictEqual(result.exitCode, 1, 'precondition: the spawn failed and the dispatch errored out')
    assert.ok(!launched(projectDir, 'async-review'), 'no worker should have run')
    const signal = getSignal('sl-nolaunch-async')
    assert.notStrictEqual(signal, null, 'a spawn that never happened must not spend the authorization')
    assert.strictEqual(signal.type, 'done')
  })

  // ── 14c ── Pins the contract behind the dispatcher's `if (handle)` guard.
  // forkParallelTask's documented non-launch return is null, and it is reached
  // only via getAsyncDir(sessionId) → null, i.e. a falsy sessionId. That is
  // unreachable together with an armed signal (setSignal/clearSignal both
  // no-op without a sessionId), so the guard is pinned here at the unit
  // boundary rather than through the dispatcher.
  it('forkParallelTask returns null—its non-launch value—when there is no session', () => {
    const { forkParallelTask } = require('../../lib/task-runner')
    const handle = forkParallelTask(
      { name: 'no-session', type: 'script', command: 'true' },
      { sessionId: null }
    )
    assert.strictEqual(handle, null, 'no session means no worker and no handle')
  })

  // ── Control 1 ── The lifecycle assertions must not depend on the names or
  // ordering of unrelated ungated tasks.
  it('control: unrelated ungated tasks renamed and reordered do not change the lifecycle', () => {
    setSignal('sl-control1', 'done', null)
    writeConfig(projectDir, makeConfig({
      claude: {
        Stop: [
          markerTask(projectDir, 'zzz-unrelated-first'),
          markerTask(projectDir, 'gated-a', { when: { signal: 'done' } }),
          markerTask(projectDir, 'aaa-unrelated-middle'),
          markerTask(projectDir, 'gated-b', { when: { signal: 'done' } }),
          blockerTask('final-blocker')
        ]
      }
    }))

    stop('sl-control1')

    assert.ok(launched(projectDir, 'gated-a'), 'first gated task should launch')
    assert.ok(launched(projectDir, 'gated-b'), 'second gated task should launch from the snapshot')
    assert.strictEqual(getSignal('sl-control1'), null, 'signal consumed exactly as in the plain arrangement')
  })

  // ── Control 2 ── A task gated on a different signal is inert.
  it('control: a task gated on "stuck" neither launches nor consumes an active "done"', () => {
    setSignal('sl-control2', 'done', null)
    writeConfig(projectDir, makeConfig({
      claude: {
        Stop: [
          markerTask(projectDir, 'stuck-gated', { when: { signal: 'stuck' } }),
          blockerTask()
        ]
      }
    }))

    stop('sl-control2')

    assert.ok(!launched(projectDir, 'stuck-gated'), 'a "stuck"-gated task must not run on a "done" signal')
    const signal = getSignal('sl-control2')
    assert.notStrictEqual(signal, null, 'the "done" authorization must be untouched')
    assert.strictEqual(signal.type, 'done')
  })
})
