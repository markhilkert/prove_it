const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const {
  invokeHook, createTempDir, cleanupTempDir, initGitRepo,
  writeConfig, makeConfig, isolatedEnv, createFastTestScript
} = require('./hook-harness')
const { getSignal } = require('../../lib/session')
const { SIGNAL_PLAN_MARKER } = require('../../lib/dispatcher/claude')

// This local branch deliberately removed TaskCompleted auto-signaling: completing
// a task titled "Run `prove_it signal done`" is no longer equivalent to executing
// that command. These tests pin the inertness.
describe('TaskCompleted is inert (no auto-signaling)', () => {
  let tmpDir, projectDir, env, origProveItDir, origHome

  const gatedConfig = () => makeConfig({
    claude: {
      Stop: [{ name: 'signal-gated', type: 'script', command: 'echo signal-task-ran', when: { signal: 'done' } }]
    }
  })

  beforeEach(() => {
    tmpDir = createTempDir('prove_it_taskcompleted_')
    projectDir = path.join(tmpDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    initGitRepo(projectDir)
    env = isolatedEnv(tmpDir)

    // Align parent process PROVE_IT_DIR with the child's so session state
    // is read/written from the same directory by both processes
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

  it('does not arm a signal for a subject naming the signal command', () => {
    writeConfig(projectDir, gatedConfig())

    const result = invokeHook('claude:TaskCompleted', {
      hook_event_name: 'TaskCompleted',
      session_id: 'tc-match',
      task_id: '1',
      task_subject: 'Run `prove_it signal done`'
    }, { projectDir, env })

    assert.strictEqual(result.exitCode, 0)
    assert.strictEqual(getSignal('tc-match'), null, 'TaskCompleted must not arm a signal')
  })

  // Subjects the removed liberal matcher used to treat as authorization.
  for (const [i, subject] of [
    'Signal the team when done',
    'Wire up SIGINT signal handler; tests done',
    'Add signal handling and mark the migration done'
  ].entries()) {
    it(`does not arm a signal for incidental subject: ${subject}`, () => {
      writeConfig(projectDir, gatedConfig())
      const sessionId = `tc-incidental-${i}`

      const result = invokeHook('claude:TaskCompleted', {
        hook_event_name: 'TaskCompleted',
        session_id: sessionId,
        task_id: String(i),
        task_subject: subject
      }, { projectDir, env })

      assert.strictEqual(result.exitCode, 0)
      assert.strictEqual(getSignal(sessionId), null, `"${subject}" must not arm a signal`)
    })
  }

  it('end-to-end: TaskCompleted then Stop leaves the gated task unrun', () => {
    createFastTestScript(projectDir, true)
    writeConfig(projectDir, gatedConfig())

    const tcResult = invokeHook('claude:TaskCompleted', {
      hook_event_name: 'TaskCompleted',
      session_id: 'tc-e2e',
      task_id: '99',
      task_subject: 'Run `prove_it signal done`'
    }, { projectDir, env })

    assert.strictEqual(tcResult.exitCode, 0)
    assert.strictEqual(getSignal('tc-e2e'), null, 'No signal should exist after TaskCompleted')

    const stopResult = invokeHook('claude:Stop', {
      session_id: 'tc-e2e'
    }, { projectDir, env, cwd: projectDir })

    assert.strictEqual(stopResult.exitCode, 0)
    assert.ok(
      !stopResult.stdout.includes('signal-task-ran'),
      `Signal-gated task must not run without an explicit signal, got: ${stopResult.stdout}`
    )
  })

  it('explicit `prove_it signal done` authorizes exactly one Stop cycle', () => {
    createFastTestScript(projectDir, true)
    writeConfig(projectDir, gatedConfig())

    // Explicit command travels the PreToolUse Bash interception path
    const sigResult = invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: 'tc-explicit',
      tool_name: 'Bash',
      tool_input: { command: 'prove_it signal done' }
    }, { projectDir, env })

    assert.strictEqual(sigResult.exitCode, 0)
    const armed = getSignal('tc-explicit')
    assert.notStrictEqual(armed, null, 'Explicit command should arm a signal')
    assert.strictEqual(armed.type, 'done')

    const stop1 = invokeHook('claude:Stop', {
      session_id: 'tc-explicit'
    }, { projectDir, env, cwd: projectDir })

    assert.strictEqual(stop1.exitCode, 0)
    assert.ok(stop1.stdout.includes('signal-task-ran'), `Gated task should run on Stop #1, got: ${stop1.stdout}`)
    assert.strictEqual(getSignal('tc-explicit'), null, 'Signal should be consumed by the launch')

    const stop2 = invokeHook('claude:Stop', {
      session_id: 'tc-explicit'
    }, { projectDir, env, cwd: projectDir })

    assert.strictEqual(stop2.exitCode, 0)
    assert.ok(
      !stop2.stdout.includes('signal-task-ran'),
      `Gated task must not rerun without a fresh explicit signal, got: ${stop2.stdout}`
    )
  })

  it('ExitPlanMode still injects the explicit signal command into the plan', () => {
    writeConfig(projectDir, gatedConfig())

    const plansDir = path.join(tmpDir, '.claude', 'plans')
    fs.mkdirSync(plansDir, { recursive: true })
    const planText = '### 1. Implement feature\n\nDo stuff.\n\n### 2. Run tests\n\nTest stuff.'
    fs.writeFileSync(path.join(plansDir, 'my-plan.md'), planText)

    const exitResult = invokeHook('claude:PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: 'tc-plan',
      tool_name: 'ExitPlanMode',
      tool_input: { plan: planText }
    }, { projectDir, env })

    assert.strictEqual(exitResult.exitCode, 0)
    const planContent = fs.readFileSync(path.join(plansDir, 'my-plan.md'), 'utf8')
    assert.ok(planContent.includes(SIGNAL_PLAN_MARKER), 'Plan file should still instruct running the signal command')
    assert.ok(planContent.includes('### 3. Run `prove_it signal done`'), 'Signal should be step 3')
  })
})
