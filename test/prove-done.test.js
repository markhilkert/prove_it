const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { getUnknownVars, KNOWN_VARS } = require('../lib/template')

const SKILL_PATH = path.join(__dirname, '..', 'lib', 'skills', 'prove-done.md')

describe('prove-done skill', () => {
  const content = fs.readFileSync(SKILL_PATH, 'utf8')

  describe('frontmatter', () => {
    it('starts with YAML frontmatter', () => {
      assert.ok(content.startsWith('---\n'), 'should start with ---')
    })

    it('has a closing frontmatter delimiter', () => {
      const endIdx = content.indexOf('\n---\n', 4)
      assert.ok(endIdx > 0, 'should have closing --- delimiter')
    })

    it('has required frontmatter fields', () => {
      const endIdx = content.indexOf('\n---\n', 4)
      const frontmatter = content.slice(4, endIdx)
      assert.ok(frontmatter.includes('name: prove-done'), 'should have name')
      assert.ok(frontmatter.includes('description:'), 'should have description')
      assert.ok(frontmatter.includes('context: fork'), 'should have context: fork')
      assert.ok(frontmatter.includes('disable-model-invocation: true'), 'should disable model invocation')
    })
  })

  describe('template variables', () => {
    it('uses only known template variables', () => {
      const endIdx = content.indexOf('\n---\n', 4)
      const body = content.slice(endIdx + 5)
      const unknown = getUnknownVars(body)
      assert.deepStrictEqual(unknown, [],
        `Unknown template variables: ${unknown.join(', ')}. Known: ${KNOWN_VARS.join(', ')}`)
    })

    it('uses expected context variables', () => {
      const endIdx = content.indexOf('\n---\n', 4)
      const body = content.slice(endIdx + 5)
      const expectedVars = ['git_status', 'changes_since_last_run', 'files_changed_since_last_run', 'session_diff', 'signal_message']
      for (const v of expectedVars) {
        assert.ok(body.includes(`{{${v}}}`), `should use {{${v}}}`)
      }
    })
  })

  describe('conditional blocks', () => {
    it('has well-formed conditional blocks', () => {
      const endIdx = content.indexOf('\n---\n', 4)
      const body = content.slice(endIdx + 5)

      const openings = [...body.matchAll(/\{\{#(\w+)\}\}/g)].map(m => m[1])
      const closings = [...body.matchAll(/\{\{\/(\w+)\}\}/g)].map(m => m[1])

      assert.deepStrictEqual(openings.sort(), closings.sort(),
        'every {{#var}} should have a matching {{/var}}')
    })
  })

  describe('verdict logic', () => {
    it('gates FAIL on FAIL-class findings rather than defaulting to it', () => {
      assert.ok(content.includes('FAIL if and only if at least one FAIL-class finding'),
        'should document the FAIL-class verdict rule')
      assert.ok(!content.includes('default verdict is FAIL'),
        'should not default to FAIL')
    })

    it('does not let minor findings compound into a FAIL', () => {
      assert.ok(content.includes('never compounding'), 'notes should not compound')
      assert.ok(!content.includes('compound into real risk'),
        'should drop the compounding-minor-findings rule')
      assert.ok(content.includes('NEVER escalate note-level findings into a FAIL'),
        'should guardrail against escalating notes')
    })

    it('reports note-level findings under a Notes section on both verdicts', () => {
      const failIdx = content.indexOf('### On FAIL')
      const passIdx = content.indexOf('### On PASS')
      assert.ok(failIdx > 0 && passIdx > failIdx, 'should have both verdict sections')
      assert.ok(content.slice(failIdx, passIdx).includes('#### Notes'), 'FAIL output should have Notes')
      assert.ok(content.slice(passIdx).includes('#### Notes'), 'PASS output should have Notes')
    })

    it('attests to the absence of FAIL-class issues, not of all findings', () => {
      assert.ok(content.includes('I found no FAIL-class issues'), 'should attest no FAIL-class issues')
      assert.ok(content.includes('genuinely note-level'), 'should attest findings are note-level')
      assert.ok(!content.includes('sections are all empty'),
        'should drop the empty-sections attestation')
      assert.ok(content.includes('All significant new logic has test coverage'),
        'coverage attestation should scope to significant new logic')
    })

    it('keeps the evidence guardrails', () => {
      for (const guardrail of [
        "NEVER raise issues you can't back up with concrete evidence",
        'NEVER count the same root cause as multiple issues',
        'NEVER flag style, formatting, or naming unless it creates a correctness risk',
        'NEVER fabricate issues to justify a FAIL',
        'NEVER rationalize away real findings to justify a PASS',
        'NEVER trust a trivially small diff at face value'
      ]) {
        assert.ok(content.includes(guardrail), `should keep guardrail: ${guardrail}`)
      }
    })
  })
})
