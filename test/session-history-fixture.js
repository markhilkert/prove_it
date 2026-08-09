// Fixture for exercising the file-history branch of the session_diff resolver.
//
// session_diff (lib/template.js) has two branches: a file-history branch that
// reads Claude Code's own tracking under ~/.claude, and a git fallback that
// only runs when the first yields nothing. Reaching the first branch requires
// real on-disk data in a real home directory layout, so this fixture builds
// one under a temporary HOME rather than mocking the resolver.
//
// Both getSessionJsonlPath and getFileHistoryDir (lib/session.js) read
// os.homedir() at call time, which honours $HOME on POSIX — so overriding the
// env var is enough to redirect them.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { makeResolvers } = require('../lib/template')
const { saveSessionState } = require('../lib/session')

const DEFAULT_SOURCES = ['src/**/*.rs']

function writeFileDeep (filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

/**
 * Build a project + fake ~/.claude file-history in a temp dir.
 *
 * @param {object} opts
 * @param {string[]} [opts.sources]    source globs the resolver filters by
 * @param {object}   [opts.committed]  relPath -> content, committed as baseline
 * @param {object}   [opts.workingTree] relPath -> content, uncommitted edits
 * @param {Array}    [opts.history]    tracked entries for the snapshot:
 *   { tracked, backup, current } where `tracked` is the path as recorded in
 *   trackedFileBackups (relative to the project, or absolute), `backup` is the
 *   pre-edit content, and `current` is the on-disk content to write. `current`
 *   may be omitted when the working tree already supplies it.
 *
 *   Because absolute paths only exist once the temp dir is made, `tracked` may
 *   start with a token: `{outside}/` (a sibling directory of the project),
 *   `{root}/` (absolute, inside the project), or `{realroot}/` (the same file
 *   spelled through the symlink-resolved project root). This is how a caller
 *   names an absolute path before build.
 */
function buildSessionHistoryFixture (opts = {}) {
  // `null` is a meaningful value (unrestricted scope), so only an absent key
  // falls back to the default — `||` would silently rewrite null into a scope.
  const sources = opts.sources === undefined ? DEFAULT_SOURCES : opts.sources
  const committed = opts.committed || {}
  const workingTree = opts.workingTree || {}
  const history = opts.history || []

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prove_it_hist_'))
  const fakeHome = path.join(tmp, 'home')
  const projectDir = path.join(tmp, 'project')
  const outsideDir = path.join(tmp, 'outside')
  fs.mkdirSync(fakeHome, { recursive: true })
  fs.mkdirSync(projectDir, { recursive: true })
  fs.mkdirSync(outsideDir, { recursive: true })

  const git = (...args) => spawnSync('git', args, { cwd: projectDir, encoding: 'utf8' })

  for (const [rel, content] of Object.entries(committed)) {
    writeFileDeep(path.join(projectDir, rel), content)
  }
  git('init', '-q')
  git('config', 'user.email', 'fixture@example.test')
  git('config', 'user.name', 'fixture')
  git('add', '.')
  git('commit', '-qm', 'baseline')
  const head = git('rev-parse', 'HEAD').stdout.trim()

  for (const [rel, content] of Object.entries(workingTree)) {
    writeFileDeep(path.join(projectDir, rel), content)
  }

  // Redirect ~/.claude and prove_it state into the fixture.
  const savedHome = process.env.HOME
  const savedProveItDir = process.env.PROVE_IT_DIR
  process.env.HOME = fakeHome
  process.env.PROVE_IT_DIR = path.join(fakeHome, '.claude', 'prove_it')

  const sessionWithHistory = 'fixture-session-with-history'
  const sessionWithoutHistory = 'fixture-session-without-history'

  // Claude Code encodes the project dir into the transcript directory name.
  const encoded = projectDir.replace(/[^a-zA-Z0-9-]/g, '-')
  const transcriptDir = path.join(fakeHome, '.claude', 'projects', encoded)
  const historyDir = path.join(fakeHome, '.claude', 'file-history', sessionWithHistory)
  fs.mkdirSync(transcriptDir, { recursive: true })
  fs.mkdirSync(historyDir, { recursive: true })

  const expandTracked = (tracked) => {
    if (tracked.startsWith('{outside}/')) {
      return path.join(outsideDir, tracked.slice('{outside}/'.length))
    }
    if (tracked.startsWith('{root}/')) {
      return path.join(projectDir, tracked.slice('{root}/'.length))
    }
    if (tracked.startsWith('{realroot}/')) {
      // Same file, spelled through the symlink-resolved root. On macOS this is
      // the /var vs /private/var alias; elsewhere it may be identical to {root}.
      return path.join(fs.realpathSync(projectDir), tracked.slice('{realroot}/'.length))
    }
    return tracked
  }

  const trackedFileBackups = {}
  history.forEach((entry, i) => {
    const backupFileName = `backup-${i}`
    writeFileDeep(path.join(historyDir, backupFileName), entry.backup)
    const tracked = expandTracked(entry.tracked)
    if (entry.current !== undefined) {
      const abs = path.isAbsolute(tracked) ? tracked : path.join(projectDir, tracked)
      writeFileDeep(abs, entry.current)
    }
    trackedFileBackups[tracked] = { version: 2, backupFileName }
  })

  const snapshot = {
    type: 'file-history-snapshot',
    snapshot: { messageId: 'msg-latest', trackedFileBackups }
  }
  fs.writeFileSync(
    path.join(transcriptDir, `${sessionWithHistory}.jsonl`),
    JSON.stringify(snapshot) + '\n'
  )

  // Both sessions share one baseline, so the git fallback sees identical
  // repository state either way.
  saveSessionState(sessionWithHistory, 'git', { head })
  saveSessionState(sessionWithoutHistory, 'git', { head })

  return {
    tmp,
    projectDir,
    outsideDir,
    fakeHome,
    head,
    sources,
    sessionWithHistory,
    sessionWithoutHistory,
    outside: (name) => path.join(outsideDir, name),
    sessionDiff (sessionId, overrides = {}) {
      return makeResolvers({
        rootDir: projectDir,
        projectDir,
        sessionId,
        toolInput: null,
        sources,
        ...overrides
      }).session_diff()
    },
    cleanup () {
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
      if (savedProveItDir === undefined) delete process.env.PROVE_IT_DIR
      else process.env.PROVE_IT_DIR = savedProveItDir
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }
}

module.exports = { buildSessionHistoryFixture, DEFAULT_SOURCES }
