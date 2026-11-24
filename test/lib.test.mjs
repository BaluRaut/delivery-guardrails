import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clockSettings, workingHours, ageInHours, bulletList, notify } from '../scripts/lib.mjs'
import { fakeServer } from './fake-servers.mjs'

const ist = clockSettings({})
const hours = (from, to, settings = ist) => workingHours(from, to, settings)

test('a pull request opened at 4pm gets 2 working hours that day', () => {
  assert.equal(hours('2026-11-23T16:00:00+05:30', '2026-11-23T20:00:00+05:30'), 2)
})

test('nights do not count', () => {
  assert.equal(hours('2026-11-23T16:00:00+05:30', '2026-11-24T10:00:00+05:30'), 3)
})

test('weekends do not count: Friday 5pm to Monday 10am is 2 hours', () => {
  assert.equal(hours('2026-11-20T17:00:00+05:30', '2026-11-23T10:00:00+05:30'), 2)
})

test('time before 9am and on Saturday is zero', () => {
  assert.equal(hours('2026-11-23T06:00:00+05:30', '2026-11-23T08:59:00+05:30'), 0)
  assert.equal(hours('2026-11-21T10:00:00+05:30', '2026-11-21T17:00:00+05:30'), 0)
})

test('partial hours and a full working week', () => {
  assert.equal(hours('2026-11-23T08:00:00+05:30', '2026-11-23T09:30:00+05:30'), 0.5)
  assert.equal(hours('2026-11-23T09:00:00+05:30', '2026-11-30T09:00:00+05:30'), 45)
})

test('holidays do not count', () => {
  const settings = clockSettings({ HOLIDAYS: '2026-11-24' })
  assert.equal(hours('2026-11-23T17:00:00+05:30', '2026-11-25T10:00:00+05:30', settings), 2)
})

test('custom hours, days and a time zone with a daylight-saving change', () => {
  const ny = clockSettings({ WORK_TIMEZONE: 'America/New_York', WORK_START: '08:30', WORK_END: '17:00', WORK_DAYS: 'Mon,Tue,Wed,Thu,Fri' })
  // US clocks go forward on Sunday 8 March 2026: Friday 16:00 EST to Monday 09:30 EDT
  assert.equal(hours('2026-03-06T16:00:00-05:00', '2026-03-09T09:30:00-04:00', ny), 2)
})

test('the calendar clock counts every hour', () => {
  const calendar = clockSettings({ AGE_CLOCK: 'calendar' })
  assert.equal(ageInHours('2026-11-21T10:00:00Z', '2026-11-21T20:00:00Z', calendar), 10)
})

test('bad settings fail loudly', () => {
  assert.throws(() => clockSettings({ WORK_START: '9am' }), /WORK_START/)
  assert.throws(() => clockSettings({ WORK_DAYS: 'Mon,Funday' }), /WORK_DAYS/)
  assert.throws(() => clockSettings({ WORK_TIMEZONE: 'Mars/Base' }))
  assert.throws(() => clockSettings({ AGE_CLOCK: 'sometimes' }), /AGE_CLOCK/)
})

test('long lists are cut with a count of the rest', () => {
  const list = bulletList(Array.from({ length: 25 }, (_, i) => `item ${i + 1}`))
  assert.equal(list.split('\n').length, 21)
  assert.match(list, /…and 5 more$/)
})

test('Slack receives the message as {"text": ...}', async () => {
  const slack = await fakeServer({ 'POST /hook': { ok: true } })
  try {
    assert.equal(await notify('hello *team*', `${slack.url}/hook`), true)
    assert.deepEqual(slack.calls[0].body, { text: 'hello *team*' })
  } finally { await slack.close() }
})

test('a Slack error fails the run instead of passing silently', async () => {
  const slack = await fakeServer({ 'POST /hook': { status: 404, text: 'no_service' } })
  try {
    await assert.rejects(notify('hello', `${slack.url}/hook`), /Slack returned 404: no_service/)
  } finally { await slack.close() }
})

test('without a webhook nothing is sent', async () => {
  assert.equal(await notify('hello', ''), false)
})
