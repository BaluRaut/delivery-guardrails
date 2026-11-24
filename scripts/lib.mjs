// Shared helpers for the guardrail scripts: settings, the working-hours
// clock, a small GitHub REST client and Slack posting. No dependencies;
// needs Node 20 or later (for fetch).

import { appendFileSync } from 'node:fs'

const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
const HOUR = 3600 * 1000

function parseTime(text, name) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim())
  if (!match || +match[1] > 24 || +match[2] > 59) throw new Error(`${name} must look like 09:00, not "${text}"`)
  return { h: +match[1], m: +match[2] }
}

/** The working-hours settings, read from environment variables. */
export function clockSettings(env = process.env) {
  const days = (env.WORK_DAYS || 'Mon,Tue,Wed,Thu,Fri').split(',').map((day) => {
    const index = DAYS[day.trim().slice(0, 3).toLowerCase()]
    if (index === undefined) throw new Error(`WORK_DAYS has an unknown day: "${day}"`)
    return index
  })
  const settings = {
    clock: env.AGE_CLOCK || 'working',
    timezone: env.WORK_TIMEZONE || 'Asia/Kolkata',
    start: parseTime(env.WORK_START || '09:00', 'WORK_START'),
    end: parseTime(env.WORK_END || '18:00', 'WORK_END'),
    days: new Set(days),
    holidays: new Set((env.HOLIDAYS || '').split(/[\s,]+/).filter(Boolean)),
  }
  if (!['working', 'calendar'].includes(settings.clock)) throw new Error(`AGE_CLOCK must be "working" or "calendar", not "${settings.clock}"`)
  new Intl.DateTimeFormat('en-US', { timeZone: settings.timezone }) // throws on an unknown time zone
  return settings
}

// The wall-clock date and time of an instant in a time zone.
function wallClock(timezone, ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms))
  const p = Object.fromEntries(parts.map((part) => [part.type, +part.value]))
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second }
}

// The instant at which the wall clock in `timezone` shows the given time.
function instantOf(timezone, y, mo, d, h, mi) {
  const target = Date.UTC(y, mo - 1, d, h, mi)
  let guess = target
  for (let i = 0; i < 3; i++) {
    const w = wallClock(timezone, guess)
    const shown = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s)
    if (shown === target) break
    guess += target - shown
  }
  return guess
}

/** Hours between two instants that fall inside working hours. */
export function workingHours(from, to, settings) {
  const start = new Date(from).getTime()
  const end = new Date(to).getTime()
  if (!(end > start)) return 0
  const first = wallClock(settings.timezone, start)
  const last = wallClock(settings.timezone, end)
  const lastDay = Date.UTC(last.y, last.mo - 1, last.d)
  let total = 0
  for (let day = Date.UTC(first.y, first.mo - 1, first.d); day <= lastDay; day += 24 * HOUR) {
    const date = new Date(day)
    const [y, mo, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
    const iso = date.toISOString().slice(0, 10)
    if (!settings.days.has(date.getUTCDay()) || settings.holidays.has(iso)) continue
    const open = instantOf(settings.timezone, y, mo, d, settings.start.h, settings.start.m)
    const close = instantOf(settings.timezone, y, mo, d, settings.end.h, settings.end.m)
    total += Math.max(0, Math.min(close, end) - Math.max(open, start))
  }
  return total / HOUR
}

/** Age in hours, on the working clock or the calendar clock. */
export function ageInHours(from, to, settings) {
  if (settings.clock === 'calendar') return Math.max(0, (new Date(to) - new Date(from)) / HOUR)
  return workingHours(from, to, settings)
}

export function formatHours(hours) {
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`
}

/** A minimal GitHub REST client that follows pagination. */
export function github(token, base = process.env.GITHUB_API_URL || 'https://api.github.com') {
  async function request(method, path, body) {
    const response = await fetch(path.startsWith('http') ? path : base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!response.ok) throw new Error(`GitHub ${method} ${path} returned ${response.status}: ${await response.text()}`)
    const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') || '')?.[1]
    return { data: response.status === 204 ? null : await response.json(), next }
  }
  return {
    get: async (path) => (await request('GET', path)).data,
    post: async (path, body) => (await request('POST', path, body)).data,
    /** Every item across all pages; stops early when `stop(item)` is true. */
    async all(path, stop = () => false) {
      const items = []
      for (let url = path; url;) {
        const { data, next } = await request('GET', url)
        for (const item of data) {
          if (stop(item)) return items
          items.push(item)
        }
        url = next
      }
      return items
    },
  }
}

/** A bulleted list, cut to `max` lines so Slack messages stay readable. */
export function bulletList(lines, max = 20) {
  const shown = lines.slice(0, max).map((line) => `• ${line}`)
  if (lines.length > max) shown.push(`…and ${lines.length - max} more`)
  return shown.join('\n')
}

/** Logs the message, adds it to the run summary and posts it to Slack if a webhook is set. */
export async function notify(text, webhook = process.env.SLACK_WEBHOOK) {
  console.log(text)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n\n`)
  if (!webhook) {
    console.log('(SLACK_WEBHOOK is not set, so nothing was sent to Slack)')
    return false
  }
  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!response.ok) throw new Error(`Slack returned ${response.status}: ${await response.text()}`)
  return true
}
