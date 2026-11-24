// Sets two commit statuses on each pull request: pr-rules/size and
// pr-rules/age. Make both required in a branch ruleset to block merging.
// On a pull_request event it checks that pull request; otherwise (the
// scheduled run) it re-checks every open pull request, because age grows
// without any new push.

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { clockSettings, ageInHours, formatHours, github } from './lib.mjs'

const round = (hours) => Math.round(hours * 10) / 10

export const DEFAULT_IGNORE = String.raw`(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.snap$|(^|/)generated/`

/** Decides both checks for one pull request. */
export function evaluate({ lines, hours, labels }, { maxLines, maxAgeHours, clock }) {
  const unit = clock === 'calendar' ? 'hours' : 'working hours'
  const size = { state: 'success', description: `${lines} lines changed (limit ${maxLines})` }
  if (lines > maxLines) {
    size.description = labels.has('size-exception')
      ? `${lines} lines changed; allowed by the size-exception label`
      : `${lines} lines changed. Split it into PRs under ${maxLines} lines.`
    if (!labels.has('size-exception')) size.state = 'failure'
  }
  const age = { state: 'success', description: `${round(hours)} ${unit} since work started (limit ${maxAgeHours})` }
  if (hours >= maxAgeHours) {
    age.description = labels.has('age-exception')
      ? `${round(hours)} ${unit} old; allowed by the age-exception label`
      : `${round(hours)} ${unit} old. Merge or split work within ${maxAgeHours} ${unit}.`
    if (!labels.has('age-exception')) age.state = 'failure'
  }
  return { size, age }
}

export async function run(env = process.env, now = new Date()) {
  const settings = clockSettings(env)
  const limits = { maxLines: Number(env.MAX_LINES || 500), maxAgeHours: Number(env.MAX_AGE_HOURS || 8), clock: settings.clock }
  const ageFrom = env.AGE_FROM || 'oldest-commit'
  const ignore = new RegExp(env.IGNORE_PATHS || DEFAULT_IGNORE)
  const repo = env.GITHUB_REPOSITORY
  const api = github(env.GITHUB_TOKEN, env.GITHUB_API_URL)
  const event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {}
  const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : undefined

  const numbers = event.pull_request
    ? [event.pull_request.number]
    : (await api.all(`/repos/${repo}/pulls?state=open&per_page=100`)).map((pr) => pr.number)

  const results = []
  for (const number of numbers) {
    const pr = await api.get(`/repos/${repo}/pulls/${number}`)
    const files = await api.all(`/repos/${repo}/pulls/${number}/files?per_page=100`)
    const ignored = files.filter((file) => ignore.test(file.filename)).reduce((n, file) => n + file.additions + file.deletions, 0)
    const lines = pr.additions + pr.deletions - ignored

    let started = pr.created_at
    if (ageFrom !== 'pr-opened') {
      const commits = await api.all(`/repos/${repo}/pulls/${number}/commits?per_page=100`)
      started = commits.map((c) => c.commit.author.date).sort()[0] || pr.created_at
    }
    const hours = ageInHours(started, now, settings)
    const labels = new Set(pr.labels.map((label) => label.name))
    const { size, age } = evaluate({ lines, hours, labels }, limits)

    for (const [context, check] of [['pr-rules/size', size], ['pr-rules/age', age]]) {
      await api.post(`/repos/${repo}/statuses/${pr.head.sha}`, { context, ...check, target_url: runUrl })
    }
    console.log(`#${number}: size ${size.state} (${lines} lines), age ${age.state} (${formatHours(hours)})`)
    results.push({ number, lines, hours, size, age })
  }
  return results
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => { console.error(error.message); process.exit(1) })
}
