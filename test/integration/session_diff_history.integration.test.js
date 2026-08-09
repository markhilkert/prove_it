// The file-history branch of session_diff (lib/template.js) must only satisfy
// the resolver with files that are inside the project root and within the
// configured source scope. Anything else is filtered out, and if that leaves
// nothing usable the existing git fallback runs instead of being suppressed.
//
// Containment and source scope are separate: containment is always enforced,
// source filtering only when `sources` is configured. isSourceFile treats empty
// sources as unrestricted, so it cannot itself be the project boundary.
//
// Path under test: session_diff -> generateDiffsSince (lib/session.js, generic,
// unfiltered) -> resolveContainedPath + isSourceFile (lib/globs.js) -> either
// the surviving history diffs or the git fallback.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const path = require('path')
const { generateDiffsSince } = require('../../lib/session')
const { buildSessionHistoryFixture } = require('../session-history-fixture')

const RUST_BASELINE = 'fn original() {}\n'
const RUST_EDITED = 'fn changed_by_session() {}\n'
const DOCS_BASELINE = '# handoff\nold line\n'
const DOCS_EDITED = '# handoff\n' + 'NEW DOCS LINE\n'.repeat(200)
const OUTSIDE_BASELINE = 'OLD OUTSIDE CONTENT\n'
const OUTSIDE_EDITED = 'FIXTURE OWNED OUTSIDE CONTENT\n'

const RUST_SOURCES = ['src/**/*.rs']
const FALLBACK_MARKER = 'Session changes (git diff)'

// Every fixture shares this repo state: an in-scope Rust change and an
// out-of-scope docs change, both uncommitted, over one baseline commit.
function fixtureWith (history, sources = RUST_SOURCES) {
  return buildSessionHistoryFixture({
    sources,
    committed: { 'src/lib.rs': RUST_BASELINE, 'docs/handoff.md': DOCS_BASELINE },
    workingTree: { 'src/lib.rs': RUST_EDITED, 'docs/handoff.md': DOCS_EDITED },
    history
  })
}

const DOCS_ENTRY = { tracked: 'docs/handoff.md', backup: DOCS_BASELINE }
const OUTSIDE_ENTRY = {
  tracked: '{outside}/private-notes.md',
  backup: OUTSIDE_BASELINE,
  current: OUTSIDE_EDITED
}
const RUST_ENTRY = { tracked: 'src/lib.rs', backup: RUST_BASELINE }

describe('session_diff file-history filtering', () => {
  // ---------- A. Out-of-scope history no longer suppresses the fallback ----------
  describe('out-of-scope history (docs only)', () => {
    let fx
    beforeEach(() => { fx = fixtureWith([DOCS_ENTRY]) })
    afterEach(() => { fx.cleanup() })

    it('CONTROL: the unfiltered history reader still sees the docs entry', () => {
      // Guards against the fixture silently ceasing to exercise the branch:
      // session.js stays generic, so the entry must still arrive here.
      const raw = generateDiffsSince(fx.sessionWithHistory, fx.projectDir, null, 100000)
      assert.strictEqual(raw.length, 1)
      assert.strictEqual(raw[0].file, 'docs/handoff.md')
    })

    it('excludes the out-of-scope docs diff', () => {
      const out = fx.sessionDiff(fx.sessionWithHistory)
      assert.ok(!out.includes('NEW DOCS LINE'), 'docs content excluded')
      assert.ok(!out.includes('docs/handoff.md'), 'docs path excluded')
    })

    it('falls through to the git fallback and supplies the source change', () => {
      const out = fx.sessionDiff(fx.sessionWithHistory)
      assert.ok(out.includes(FALLBACK_MARKER), 'git fallback ran')
      assert.ok(out.includes(RUST_EDITED.trim()), 'in-scope source change present')
    })
  })

  // ---------- B & C. Out-of-root history ----------
  describe('history tracking a path outside the project root', () => {
    let fx
    beforeEach(() => { fx = fixtureWith([OUTSIDE_ENTRY]) })
    afterEach(() => { fx.cleanup() })

    it('excludes the absolute out-of-root path and its content', () => {
      const out = fx.sessionDiff(fx.sessionWithHistory)
      assert.ok(!out.includes(fx.outside('private-notes.md')), 'absolute path absent')
      assert.ok(!out.includes(OUTSIDE_EDITED.trim()), 'outside content absent')
    })

    it('cannot suppress the fallback: the source change still reaches the reviewer', () => {
      const out = fx.sessionDiff(fx.sessionWithHistory)
      assert.ok(out.includes(FALLBACK_MARKER), 'git fallback ran')
      assert.ok(out.includes(RUST_EDITED.trim()), 'in-scope source change present')
    })
  })

  // ---------- D. Valid in-scope history is preserved ----------
  describe('in-scope history', () => {
    let fx
    beforeEach(() => { fx = fixtureWith([RUST_ENTRY]) })
    afterEach(() => { fx.cleanup() })

    it('keeps the file-history diff and does not fall back to git', () => {
      const out = fx.sessionDiff(fx.sessionWithHistory)
      assert.ok(out.includes('src/lib.rs'), 'source path present')
      assert.ok(out.includes(RUST_EDITED.trim()), 'source change present')
      assert.ok(!out.includes(FALLBACK_MARKER), 'history branch satisfied the resolver')
    })
  })

  // ---------- E. Mixed history ----------
  describe('mixed history (source + docs + outside)', () => {
    let fx
    beforeEach(() => { fx = fixtureWith([RUST_ENTRY, DOCS_ENTRY, OUTSIDE_ENTRY]) })
    afterEach(() => { fx.cleanup() })

    it('CONTROL: all three entries reach the filter unfiltered', () => {
      const raw = generateDiffsSince(fx.sessionWithHistory, fx.projectDir, null, 100000)
      assert.strictEqual(raw.length, 3)
    })

    it('retains only the in-scope source entry', () => {
      const out = fx.sessionDiff(fx.sessionWithHistory)
      assert.ok(out.includes(RUST_EDITED.trim()), 'source retained')
      assert.ok(!out.includes('NEW DOCS LINE'), 'docs excluded')
      assert.ok(!out.includes(OUTSIDE_EDITED.trim()), 'outside content excluded')
      assert.ok(!out.includes(fx.outside('private-notes.md')), 'outside path excluded')
    })
  })

  // ---------- F. Empty / null sources: containment must survive ----------
  describe('unrestricted source scope', () => {
    for (const [label, sources] of [['empty array', []], ['null', null]]) {
      describe(`sources = ${label}`, () => {
        let fx
        beforeEach(() => { fx = fixtureWith([DOCS_ENTRY, OUTSIDE_ENTRY], sources) })
        afterEach(() => { fx.cleanup() })

        it('retains the in-project file (unrestricted scope) ...', () => {
          const out = fx.sessionDiff(fx.sessionWithHistory)
          assert.ok(out.includes('docs/handoff.md'), 'in-project history retained')
        })

        it('... but still excludes the out-of-root file', () => {
          const out = fx.sessionDiff(fx.sessionWithHistory)
          assert.ok(!out.includes(fx.outside('private-notes.md')), 'absolute path absent')
          assert.ok(!out.includes(OUTSIDE_EDITED.trim()), 'outside content absent')
        })
      })
    }
  })

  // ---------- G. Path normalization / realpath alias ----------
  describe('realpath-aliased in-project paths', () => {
    let fx
    beforeEach(() => {
      // Recorded through the symlink-resolved root rather than the path the
      // caller passed as rootDir — the /var vs /private/var shape on macOS.
      fx = fixtureWith([{ tracked: '{realroot}/src/lib.rs', backup: RUST_BASELINE }])
    })
    afterEach(() => { fx.cleanup() })

    it('CONTROL: the fixture really did record an absolute path', () => {
      const raw = generateDiffsSince(fx.sessionWithHistory, fx.projectDir, null, 100000)
      assert.strictEqual(raw.length, 1)
      assert.ok(path.isAbsolute(raw[0].file), 'recorded form is absolute')
    })

    it('is not falsely rejected as out-of-root', () => {
      const out = fx.sessionDiff(fx.sessionWithHistory)
      assert.ok(out.includes(RUST_EDITED.trim()), 'in-scope source survived filtering')
      assert.ok(!out.includes(FALLBACK_MARKER), 'kept via the history branch, not the fallback')
    })
  })

  // ---------- Escape via a symlink out of the project ----------
  //
  // resolveContainedPath normalizes with realpath, which cannot resolve a path
  // whose components do not exist. A tracked path several *missing* components
  // below an escaping symlink stays lexical and passes containment — a real
  // weakness in the helper, measured directly.
  //
  // It is not reachable from here, structurally: session.js only emits a diff
  // for a file that currently exists, and a file cannot exist while its parents
  // do not — so anything that produces a diff also realpaths, through the
  // symlink and out of the project. Measured both ways: present -> entry
  // produced and correctly filtered; absent -> no entry produced at all.
  //
  // These pin the end-to-end guarantee, not the mechanism. Removing session.js's
  // existsSync gate alone does not break them (readFileSync then throws inside
  // the surrounding try/catch); a refactor treating a deleted file as empty
  // content does, and then the backup content leaks — verified, these go red.
  describe('history tracking a path below a symlink out of the project', () => {
    const TRACKED = 'escape/deleted/subdir/secret.txt'
    const BACKUP_SECRET = 'OUTSIDE BACKUP SECRET\n'
    const CURRENT_SECRET = 'OUTSIDE CURRENT SECRET\n'

    function escapeFixture (currentContent) {
      return buildSessionHistoryFixture({
        realpathTmp: true, // isolate the symlink under test from the /var alias
        sources: RUST_SOURCES,
        symlinks: { escape: '{outside}' },
        committed: { 'src/lib.rs': RUST_BASELINE },
        workingTree: { 'src/lib.rs': RUST_EDITED },
        history: [{
          tracked: TRACKED,
          backup: BACKUP_SECRET,
          ...(currentContent === undefined ? {} : { current: currentContent })
        }]
      })
    }

    it('emits no history at all when the escaping path no longer exists', () => {
      const fx = escapeFixture(undefined)
      try {
        const raw = generateDiffsSince(fx.sessionWithHistory, fx.projectDir, null, 100000)
        assert.strictEqual(raw.length, 0, 'a missing current file yields no diff to leak')

        const out = fx.sessionDiff(fx.sessionWithHistory)
        assert.ok(!out.includes(BACKUP_SECRET.trim()), 'backup content never surfaces')
        assert.ok(out.includes(FALLBACK_MARKER), 'fallback ran')
        assert.ok(out.includes(RUST_EDITED.trim()), 'in-scope source delivered')
      } finally { fx.cleanup() }
    })

    it('filters the entry out when the escaping path does exist', () => {
      const fx = escapeFixture(CURRENT_SECRET)
      try {
        // CONTROL: the reader really does hand this entry to the filter, so the
        // assertions below test the filter and not an empty input.
        const raw = generateDiffsSince(fx.sessionWithHistory, fx.projectDir, null, 100000)
        assert.strictEqual(raw.length, 1, 'entry reaches the filter')
        assert.strictEqual(raw[0].file, TRACKED)

        const out = fx.sessionDiff(fx.sessionWithHistory)
        assert.ok(!out.includes(CURRENT_SECRET.trim()), 'outside content excluded')
        assert.ok(!out.includes(BACKUP_SECRET.trim()), 'outside backup excluded')
        assert.ok(!out.includes(TRACKED), 'escaping path excluded')
        assert.ok(out.includes(FALLBACK_MARKER), 'fallback ran instead')
        assert.ok(out.includes(RUST_EDITED.trim()), 'in-scope source delivered')
      } finally { fx.cleanup() }
    })
  })

  // ---------- H. History vs fallback, identical repository state ----------
  describe('history and fallback paths over identical repository state', () => {
    let fx
    beforeEach(() => { fx = fixtureWith([RUST_ENTRY, DOCS_ENTRY, OUTSIDE_ENTRY]) })
    afterEach(() => { fx.cleanup() })

    it('both paths surface the source change and exclude everything else', () => {
      const viaHistory = fx.sessionDiff(fx.sessionWithHistory)
      const viaFallback = fx.sessionDiff(fx.sessionWithoutHistory)

      assert.ok(!viaHistory.includes(FALLBACK_MARKER), 'first session used history')
      assert.ok(viaFallback.includes(FALLBACK_MARKER), 'second session used the fallback')

      for (const [label, out] of [['history', viaHistory], ['fallback', viaFallback]]) {
        assert.ok(out.includes(RUST_EDITED.trim()), `${label}: source change present`)
        assert.ok(!out.includes('NEW DOCS LINE'), `${label}: docs excluded`)
        assert.ok(!out.includes(OUTSIDE_EDITED.trim()), `${label}: outside content excluded`)
      }
    })
  })
})
