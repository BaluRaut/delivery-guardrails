// Finds stuck work in the team's repos and sends one Slack message:
//   • pull requests open longer than MAX_PR_HOURS, grouped by who must act
//   • merged pull requests not on UAT within MAX_UAT_HOURS
//   • a failed latest UAT deployment, and repos with no UAT deployments recorded
// Ages use the working-hours clock unless AGE_CLOCK=calendar.

import { pathToFileURL } from 'node:url'
import { clockSettings, ageInHours, formatHours, github, bulletList, notify } from './lib.mjs'

export const STAGES = {
  'first-review': 'Waiting for a first review (reviewers to act)',
  approval: 'Reviewed, waiting for approval (reviewers to act)',
  changes: 'Changes requested (author to act)',
  approved: 'Approved but not merged (author to act)',
}

/** Where a pull request is stuck, and who should act. Reviews must be oldest first. */
export function stageOf(pr, reviews) {
  const author = pr.user.login
  const latest = new Map()
  for (const review of reviews) {
    const reviewer = review.user?.login
    if (!reviewer || reviewer === author || ['COMMENTED', 'PENDING'].includes(review.state)) continue
    latest.set(reviewer, review.state)
  }
  const states = [...latest.values()]
  const requested = [
    ...(pr.requested_reviewers || []).map((user) => `@${user.login}`),
    ...(pr.requested_teams || []).map((team) => `@${team.slug}`),
  ]
  if (states.includes('CHANGES_REQUESTED')) return { stage: 'changes', who: `@${author}` }
  if (states.includes('APPROVED') && requested.length === 0) return { stage: 'approved', who: `@${author}` }
  const reviewed = reviews.some((review) => review.user?.login && review.user.login !== author)
  const who = requested.length ? requested.join(' ') : 'no reviewer assigned'
  return { stage: reviewed ? 'approval' : 'first-review', who }
}

/** Builds the Slack message, or returns '' when there is nothing to report. */
export function buildMessage({ stuck, late, failed, unrecorded }, limits) {
  const unit = limits.clock === 'calendar' ? 'hours' : 'working hours'
  const sections = []
  if (stuck.length) {
    const parts = [`*Pull requests open more than ${limits.maxPrHours} ${unit}*`]
    for (const [key, title] of Object.entries(STAGES)) {
      const items = stuck.filter((item) => item.stage === key)
      if (items.length) parts.push(`_${title}_\n${bulletList(items.map((item) => item.line))}`)
    }
    sections.push(parts.join('\n'))
  }
  if (late.length) sections.push(`*Merged but not on ${limits.uatEnvironment} after ${limits.maxUatHours} ${unit}*\n${bulletList(late)}`)
  if (failed.length) sections.push(`*Latest ${limits.uatEnvironment} deployment failed*\n${bulletList(failed)}`)
  if (unrecorded.length) sections.push(`*No ${limits.uatEnvironment} deployments recorded, so these repos can't be checked*\n${bulletList(unrecorded)}`)
  return sections.join('\n\n')
}

export async function run(env = process.env, now = new Date()) {
  const settings = clockSettings(env)
  const limits = {
    clock: settings.clock,
    maxPrHours: Number(env.MAX_PR_HOURS || 6),
    maxUatHours: Number(env.MAX_UAT_HOURS || 7),
    uatEnvironment: env.UAT_ENVIRONMENT || 'uat',
  }
  const repos = (env.TEAM_REPOS || env.GITHUB_REPOSITORY || '').split(/\s+/).filter(Boolean)
  const api = github(env.GITHUB_TOKEN, env.GITHUB_API_URL)
  const since = new Date(now.getTime() - 14 * 24 * 3600 * 1000)
  const found = { stuck: [], late: [], failed: [], unrecorded: [] }

  for (const repo of repos) {
    const name = repo.split('/')[1]

    // Pull requests open too long, by stage
    for (const pr of await api.all(`/repos/${repo}/pulls?state=open&per_page=100`)) {
      if (pr.draft) continue
      const hours = ageInHours(pr.created_at, now, settings)
      if (hours < limits.maxPrHours) continue
      const reviews = await api.all(`/repos/${repo}/pulls/${pr.number}/reviews?per_page=100`)
      const { stage, who } = stageOf(pr, reviews)
      found.stuck.push({ stage, line: `<${pr.html_url}|${name}#${pr.number}> ${pr.title} · ${formatHours(hours)} · by @${pr.user.login} · ${who}` })
    }

    // UAT: what is deployed, and did the latest deployment fail?
    const deployments = await api.get(`/repos/${repo}/deployments?environment=${encodeURIComponent(limits.uatEnvironment)}&per_page=30`)
    let uatSha = null
    for (const [index, deployment] of deployments.entries()) {
      const [status] = await api.get(`/repos/${repo}/deployments/${deployment.id}/statuses?per_page=1`)
      if (index === 0 && status && ['failure', 'error'].includes(status.state)) {
        found.failed.push(`${name}: deployment of ${deployment.sha.slice(0, 7)} ${status.state === 'error' ? 'errored' : 'failed'} ${formatHours(ageInHours(status.created_at, now, { ...settings, clock: 'calendar' }))} ago`)
      }
      if (status?.state === 'success') { uatSha = deployment.sha; break }
    }
    if (!uatSha) { found.unrecorded.push(name); continue }

    // Merged pull requests whose merge commit is not in the UAT commit
    const { default_branch: branch } = await api.get(`/repos/${repo}`)
    const closed = await api.all(
      `/repos/${repo}/pulls?state=closed&base=${encodeURIComponent(branch)}&sort=updated&direction=desc&per_page=100`,
      (pr) => new Date(pr.updated_at) < since,
    )
    for (const pr of closed) {
      if (!pr.merged_at || new Date(pr.merged_at) < since || !pr.merge_commit_sha) continue
      const hours = ageInHours(pr.merged_at, now, settings)
      if (hours < limits.maxUatHours) continue
      const { status } = await api.get(`/repos/${repo}/compare/${pr.merge_commit_sha}...${uatSha}`)
      if (status !== 'ahead' && status !== 'identical') {
        found.late.push(`<${pr.html_url}|${name}#${pr.number}> ${pr.title} · merged ${formatHours(hours)} ago`)
      }
    }
  }

  const message = buildMessage(found, limits)
  if (message) await notify(message, env.SLACK_WEBHOOK)
  else console.log('Nothing is stuck.')
  return { found, message }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => { console.error(error.message); process.exit(1) })
}
