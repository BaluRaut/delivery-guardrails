import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluate, run } from '../scripts/pr-rules.mjs'
import { fakeServer } from './fake-servers.mjs'

const limits = { maxLines: 500, maxAgeHours: 8, clock: 'working' }

test('size: over the limit fails, the label allows it', () => {
  assert.equal(evaluate({ lines: 600, hours: 1, labels: new Set() }, limits).size.state, 'failure')
  const allowed = evaluate({ lines: 600, hours: 1, labels: new Set(['size-exception']) }, limits).size
  assert.equal(allowed.state, 'success')
  assert.match(allowed.description, /allowed by the size-exception label/)
  assert.equal(evaluate({ lines: 500, hours: 1, labels: new Set() }, limits).size.state, 'success')
  assert.equal(evaluate({ lines: 1, hours: 1, labels: new Set() }, limits).size.description, '1 line changed (limit 500)')
})

test('age: at the limit fails, the label allows it, descriptions fit GitHub', () => {
  const late = evaluate({ lines: 10, hours: 8, labels: new Set() }, limits).age
  assert.equal(late.state, 'failure')
  assert.equal(late.description, '8 working hours old. Merge or split work within 8 working hours.')
  assert.ok(late.description.length <= 140)
  assert.equal(evaluate({ lines: 10, hours: 9.5, labels: new Set(['age-exception']) }, limits).age.state, 'success')
  assert.equal(evaluate({ lines: 10, hours: 7.9, labels: new Set() }, limits).age.state, 'success')
})

// A pull request with 150 files (more than one page) where most lines are a lock file.
function bigPullRequest() {
  const files = Array.from({ length: 150 }, (_, i) => ({ filename: `src/file${i}.js`, additions: 2, deletions: 0 }))
  files.push({ filename: 'package-lock.json', additions: 5000, deletions: 0 })
  return files
}

test('end to end: pages through 151 files, ignores the lock file, posts both statuses', async () => {
  const api = await fakeServer({
    'GET /repos/team/app/pulls/7': {
      number: 7, additions: 5300, deletions: 0, created_at: '2026-11-23T10:00:00+05:30',
      labels: [], head: { sha: 'abc123' },
    },
    'GET /repos/team/app/pulls/7/files': bigPullRequest(),
    'GET /repos/team/app/pulls/7/commits': [
      { commit: { author: { date: '2026-11-23T11:00:00+05:30' } } },
      { commit: { author: { date: '2026-11-23T09:30:00+05:30' } } },
    ],
    'POST /repos/team/app/statuses/abc123': { ok: true },
  })
  const dir = mkdtempSync(join(tmpdir(), 'pr-rules-'))
  writeFileSync(join(dir, 'event.json'), JSON.stringify({ pull_request: { number: 7 } }))
  try {
    const [result] = await run({
      GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'team/app', GITHUB_API_URL: api.url, GITHUB_EVENT_PATH: join(dir, 'event.json'),
    }, new Date('2026-11-23T20:00:00+05:30'))
    assert.equal(result.lines, 300)              // 5300 minus the 5000-line lock file
    assert.equal(result.hours, 8.5)              // 09:30 to 18:00 on the working clock
    const statuses = api.calls.filter((c) => c.method === 'POST').map((c) => [c.body.context, c.body.state])
    assert.deepEqual(statuses, [['pr-rules/size', 'success'], ['pr-rules/age', 'failure']])
    assert.ok(api.calls.some((c) => c.path.endsWith('/files') && c.query.includes('page=2')), 'reads the second page of files')
  } finally { await api.close() }
})

test('scheduled run checks every open pull request', async () => {
  const pr = (number) => ({ number, additions: 1, deletions: 0, created_at: '2026-11-23T17:00:00+05:30', labels: [], head: { sha: `sha${number}` } })
  const api = await fakeServer({
    'GET /repos/team/app/pulls': [pr(1), pr(2)],
    'GET /repos/team/app/pulls/1': pr(1), 'GET /repos/team/app/pulls/2': pr(2),
    'GET /repos/team/app/pulls/1/files': [], 'GET /repos/team/app/pulls/2/files': [],
    'POST /repos/team/app/statuses/sha1': {}, 'POST /repos/team/app/statuses/sha2': {},
  })
  try {
    const results = await run({ GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'team/app', GITHUB_API_URL: api.url, AGE_FROM: 'pr-opened' },
      new Date('2026-11-24T10:00:00+05:30'))
    assert.deepEqual(results.map((r) => [r.number, r.hours]), [[1, 2], [2, 2]])
  } finally { await api.close() }
})
