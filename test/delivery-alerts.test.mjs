import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stageOf, run } from '../scripts/delivery-alerts.mjs'
import { fakeServer } from './fake-servers.mjs'

const user = (login) => ({ login })
const review = (login, state) => ({ user: user(login), state })
const pr = (extra = {}) => ({ user: user('asha'), requested_reviewers: [user('ravi')], requested_teams: [], ...extra })

test('stage: no reviews yet means waiting for a first review', () => {
  assert.deepEqual(stageOf(pr(), []), { stage: 'first-review', who: '@ravi' })
  assert.deepEqual(stageOf(pr({ requested_reviewers: [] }), []), { stage: 'first-review', who: 'no reviewer assigned' })
})

test('stage: comments only means waiting for approval', () => {
  assert.equal(stageOf(pr(), [review('ravi', 'COMMENTED')]).stage, 'approval')
})

test('stage: changes requested puts it on the author', () => {
  assert.deepEqual(stageOf(pr(), [review('ravi', 'CHANGES_REQUESTED')]), { stage: 'changes', who: '@asha' })
})

test('stage: a later approval replaces the earlier change request', () => {
  const s = stageOf(pr({ requested_reviewers: [] }), [review('ravi', 'CHANGES_REQUESTED'), review('ravi', 'APPROVED')])
  assert.deepEqual(s, { stage: 'approved', who: '@asha' })
})

test("stage: the author's own reviews are ignored", () => {
  assert.equal(stageOf(pr(), [review('asha', 'COMMENTED')]).stage, 'first-review')
})

test('end to end: stuck PRs by stage, a merged PR missing from UAT, and a repo with no UAT records', async () => {
  const now = new Date('2026-11-24T15:00:00+05:30')
  const open = [
    { number: 1, title: 'Add cancel button', draft: false, created_at: '2026-11-23T10:00:00+05:30', html_url: 'https://gh/1', user: user('asha'), requested_reviewers: [user('ravi')], requested_teams: [] },
    { number: 2, title: 'Refund worker', draft: false, created_at: '2026-11-23T11:00:00+05:30', html_url: 'https://gh/2', user: user('meera'), requested_reviewers: [], requested_teams: [] },
    { number: 3, title: 'Fresh PR', draft: false, created_at: '2026-11-24T14:00:00+05:30', html_url: 'https://gh/3', user: user('asha'), requested_reviewers: [], requested_teams: [] },
    { number: 4, title: 'Draft idea', draft: true, created_at: '2026-11-10T10:00:00+05:30', html_url: 'https://gh/4', user: user('asha'), requested_reviewers: [], requested_teams: [] },
  ]
  const closed = [
    { number: 9, title: 'Deployed fix', merged_at: '2026-11-23T10:00:00+05:30', updated_at: '2026-11-23T10:00:00+05:30', merge_commit_sha: 'm9', html_url: 'https://gh/9' },
    { number: 8, title: 'Waiting for UAT', merged_at: '2026-11-23T12:00:00+05:30', updated_at: '2026-11-23T12:00:00+05:30', merge_commit_sha: 'm8', html_url: 'https://gh/8' },
    { number: 6, title: 'Closed without merging', merged_at: null, updated_at: '2026-11-23T12:00:00+05:30', html_url: 'https://gh/6' },
  ]
  const api = await fakeServer({
    'GET /repos/team/app/pulls': (url) => (url.searchParams.get('state') === 'open' ? open : closed),
    'GET /repos/team/app/pulls/1/reviews': [],
    'GET /repos/team/app/pulls/2/reviews': [review('ravi', 'APPROVED')],
    'GET /repos/team/app/deployments': [{ id: 51, sha: 'bad' }, { id: 50, sha: 'uat1' }],
    'GET /repos/team/app/deployments/51/statuses': [{ state: 'failure', created_at: '2026-11-24T13:00:00+05:30' }],
    'GET /repos/team/app/deployments/50/statuses': [{ state: 'success', created_at: '2026-11-23T11:00:00+05:30' }],
    'GET /repos/team/app': { default_branch: 'main' },
    'GET /repos/team/app/compare/m9...uat1': { status: 'ahead' },
    'GET /repos/team/app/compare/m8...uat1': { status: 'behind' },
    'GET /repos/team/web/pulls': [],
    'GET /repos/team/web/deployments': [],
    'POST /hook': { ok: true },
  })
  try {
    const { found, message } = await run({
      GITHUB_TOKEN: 't', GITHUB_API_URL: api.url, TEAM_REPOS: 'team/app team/web', SLACK_WEBHOOK: `${api.url}/hook`,
    }, now)
    assert.deepEqual(found.stuck.map((s) => s.stage), ['first-review', 'approved'])
    assert.equal(found.late.length, 1)
    assert.match(found.late[0], /app#8> Waiting for UAT · merged 12h ago/)
    assert.equal(found.failed.length, 1)
    assert.match(found.failed[0], /deployment of bad failed 2h ago/)
    assert.deepEqual(found.unrecorded, ['web'])
    assert.match(message, /Waiting for a first review[\s\S]*app#1> Add cancel button · 14h · by @asha · @ravi/)
    assert.match(message, /Approved but not merged[\s\S]*app#2> Refund worker · 13h · by @meera · @meera/)
    const sent = api.calls.find((c) => c.path === '/hook')
    assert.equal(sent.body.text, message)
  } finally { await api.close() }
})
