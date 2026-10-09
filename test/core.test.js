/**
 * Unit tests for the framework-free core: state normalization, statistics and
 * CSV export. Run with `node --test test/`.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  normalizeSettings,
  normalizeRecord,
  normalizeState,
  normalizeReason,
  isPresetReason,
  plannedMsFor,
  DEFAULT_SETTINGS,
  STATE_VERSION,
  INTERRUPT_REASONS,
} from '../lib/core/state.js'
import {
  computeStats,
  dayKey,
  weekKey,
  startOfWeek,
  filterByDateRange,
  UNKNOWN_REASON,
} from '../lib/core/stats.js'
import {
  csvField,
  toCsv,
  csvDocument,
  buildRecordsCsv,
  recordRows,
  reasonRows,
  UTF8_BOM,
  formatLocalDateTime,
  minutesOf,
} from '../lib/core/csv.js'

/** A well-formed focus record at `time`, completed. */
function focusAt(time, overrides = {}) {
  return {
    id: `r-${time}`,
    project: '项目A',
    source: 'manual',
    sessionId: '',
    phase: 'focus',
    status: 'completed',
    startedAt: time,
    endedAt: time + 25 * 60_000,
    plannedMs: 25 * 60_000,
    focusedMs: 25 * 60_000,
    note: '',
    ...overrides,
  }
}

/**
 * The client half is a prebuilt plain-script bundle that cannot import the
 * host's schema module, so it repeats the preset reason list. This asserts the
 * two copies never drift apart.
 */
test('the client reason list matches the core INTERRUPT_REASONS', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const match = /var REASONS = \[([^\]]*)\]/.exec(source)
  assert.ok(match, 'could not find the client REASONS list')
  const clientReasons = match[1]
    .split(',')
    .map((part) => part.trim().replace(/^'|'$/g, ''))
    .filter((part) => part !== '')
  assert.deepEqual(clientReasons, [...INTERRUPT_REASONS])
})

test('normalizeReason keeps presets verbatim and caps free text', () => {
  assert.equal(normalizeReason('开会'), '开会')
  assert.equal(normalizeReason('临时插了个线上问题'), '临时插了个线上问题')
  assert.equal(normalizeReason('  多   空格  '), '多 空格', 'whitespace is collapsed')
  assert.equal(normalizeReason(''), '')
  assert.equal(normalizeReason(null), '')
  assert.equal(normalizeReason(42), '')
  assert.equal(normalizeReason('x'.repeat(500)).length, 200, 'free text is length-capped')
})

test('isPresetReason distinguishes presets from custom text', () => {
  for (const preset of INTERRUPT_REASONS) assert.equal(isPresetReason(preset), true)
  assert.equal(isPresetReason('我自己编的'), false)
  assert.equal(isPresetReason(''), false)
})

test('normalizeRecord keeps the reason and defaults it to empty', () => {
  const withReason = normalizeRecord({ startedAt: 1_700_000_000_000, status: 'aborted', reason: '开会' })
  assert.equal(withReason.reason, '开会')
  // A run that was never asked must not be reported as "其他".
  const withoutReason = normalizeRecord({ startedAt: 1_700_000_000_000, status: 'completed' })
  assert.equal(withoutReason.reason, '')
})

test('the new interruption and card settings have safe defaults', () => {
  const settings = normalizeSettings(undefined)
  assert.equal(settings.autoStartBreak, true, 'a break should start by default')
  assert.equal(settings.autoStartNext, false, 'the next focus must stay manual by default')
  assert.equal(settings.cardEnabled, true)
  // Hostile input cannot flip them into non-booleans.
  const junk = normalizeSettings({ autoStartBreak: 'yes', cardEnabled: 0 })
  assert.equal(junk.autoStartBreak, true)
  assert.equal(junk.cardEnabled, true)
})

test('normalizeSettings fills defaults and clamps out-of-range values', () => {
  const filled = normalizeSettings(undefined)
  assert.equal(filled.focusMinutes, DEFAULT_SETTINGS.focusMinutes)
  assert.equal(filled.longBreakEvery, DEFAULT_SETTINGS.longBreakEvery)

  const clamped = normalizeSettings({ focusMinutes: 0, shortBreakMinutes: 9999, longBreakEvery: -3 })
  assert.equal(clamped.focusMinutes, 1)
  assert.equal(clamped.shortBreakMinutes, 60)
  assert.equal(clamped.longBreakEvery, 1)
})

test('normalizeSettings rejects non-numeric and non-string junk', () => {
  const result = normalizeSettings({ focusMinutes: 'abc', defaultProject: '   ', autoStartNext: 'yes' })
  assert.equal(result.focusMinutes, DEFAULT_SETTINGS.focusMinutes)
  assert.equal(result.defaultProject, DEFAULT_SETTINGS.defaultProject)
  assert.equal(result.autoStartNext, DEFAULT_SETTINGS.autoStartNext)
})

test('normalizeSettings reads the floating timer and break-activity defaults', () => {
  const def = normalizeSettings(undefined)
  assert.equal(def.showFloatingTimer, false)
  assert.equal(def.floatPosition, null)
  assert.deepEqual(def.breakActivities, DEFAULT_SETTINGS.breakActivities)
})

test('normalizeSettings cleans hostile break-activity input', () => {
  // null / non-array -> defaults; blanks and duplicates are dropped; length is capped.
  const a = normalizeSettings({ breakActivities: null })
  assert.deepEqual(a.breakActivities, DEFAULT_SETTINGS.breakActivities)

  const b = normalizeSettings({ breakActivities: ['深蹲十个', '  ', '深蹲十个', '喝一杯水', 123] })
  assert.deepEqual(b.breakActivities, ['深蹲十个', '喝一杯水'])

  // An entirely empty list falls back to defaults rather than leaving a break
  // with nothing to suggest.
  const c = normalizeSettings({ breakActivities: ['', '   ', null] })
  assert.deepEqual(c.breakActivities, DEFAULT_SETTINGS.breakActivities)

  // floatPosition must be a {x,y} of finite non-negative numbers or it is null.
  assert.equal(normalizeSettings({ floatPosition: { x: 10, y: -5 } }).floatPosition, null)
  assert.deepEqual(normalizeSettings({ floatPosition: { x: 30, y: 40 } }).floatPosition, { x: 30, y: 40 })
  assert.equal(normalizeSettings({ floatPosition: 'nope' }).floatPosition, null)
})

test('normalizeRecord drops records without a start time', () => {
  assert.equal(normalizeRecord({ phase: 'focus' }), null)
  assert.equal(normalizeRecord(null), null)
  assert.equal(normalizeRecord({ startedAt: -5 }), null)
})

test('normalizeRecord repairs unknown enums and keeps the log usable', () => {
  const record = normalizeRecord({ startedAt: 1_700_000_000_000, phase: 'nap', status: 'bogus', project: '  X  ' })
  assert.equal(record.phase, 'focus')
  assert.equal(record.status, 'completed')
  assert.equal(record.project, 'X')
})

test('normalizeState sorts records and survives a corrupt document', () => {
  const later = 1_700_000_000_000
  const earlier = later - 86_400_000
  const state = normalizeState({
    version: 99,
    settings: { focusMinutes: 50 },
    records: [focusAt(later), { junk: true }, focusAt(earlier)],
  })
  assert.equal(state.version, STATE_VERSION)
  assert.equal(state.records.length, 2)
  assert.ok(state.records[0].startedAt < state.records[1].startedAt)
  assert.equal(state.settings.focusMinutes, 50)

  const empty = normalizeState('not a document')
  assert.deepEqual(empty.records, [])
  assert.equal(empty.settings.focusMinutes, DEFAULT_SETTINGS.focusMinutes)
})

test('plannedMsFor maps each phase to its configured minutes', () => {
  const settings = normalizeSettings({ focusMinutes: 30, shortBreakMinutes: 6, longBreakMinutes: 20 })
  assert.equal(plannedMsFor(settings, 'focus'), 30 * 60_000)
  assert.equal(plannedMsFor(settings, 'short-break'), 6 * 60_000)
  assert.equal(plannedMsFor(settings, 'long-break'), 20 * 60_000)
})

test('dayKey and weekKey are local-calendar keys', () => {
  // 2026-10-08 is a Thursday; its ISO week is 2026-W41.
  const time = new Date(2026, 9, 8, 15, 30, 0).getTime()
  assert.equal(dayKey(time), '2026-10-08')
  assert.equal(weekKey(time), '2026-W41')
  // Monday 2026-10-05 starts that same week.
  const monday = new Date(2026, 9, 5, 0, 0, 0).getTime()
  assert.equal(startOfWeek(time), monday)
})

test('computeStats separates completed, aborted and skipped runs', () => {
  const now = new Date(2026, 9, 8, 12, 0, 0).getTime()
  const records = [
    focusAt(now - 3 * 3_600_000),
    focusAt(now - 2 * 3_600_000),
    focusAt(now - 3_600_000, { status: 'aborted', focusedMs: 5 * 60_000, project: '项目B' }),
    focusAt(now - 1_800_000, { status: 'skipped', focusedMs: 60_000, project: '项目B' }),
    focusAt(now - 900_000, { phase: 'short-break', plannedMs: 5 * 60_000, focusedMs: 5 * 60_000 }),
  ]
  const stats = computeStats(records, now)

  assert.equal(stats.scope.today.completed, 2)
  assert.equal(stats.scope.today.aborted, 1)
  assert.equal(stats.scope.today.skipped, 1)
  // Breaks never enter focus statistics.
  assert.equal(stats.scope.total.focusedMinutes, 50 + 5 + 1)
  assert.equal(stats.scope.today.totalRuns, 4)
  assert.equal(stats.scope.today.completionRate, 50)

  const projectB = stats.projects.find((p) => p.project === '项目B')
  assert.equal(projectB.completed, 0)
  assert.equal(projectB.aborted, 1)
  assert.equal(projectB.skipped, 1)

  // Share is over completed focus time only, so 50 of 56 minutes.
  const shareSum = stats.projects.reduce((sum, p) => sum + p.sharePercent, 0)
  assert.ok(Math.abs(shareSum - 100) < 0.2, `shares should total ~100, got ${shareSum}`)
})

test('an interruption event is counted separately and adds no time', () => {
  const now = new Date(2026, 9, 8, 12, 0, 0).getTime()
  const records = [
    // One pomodoro: interrupted at 10 minutes, then finished with the full 25.
    focusAt(now - 3_600_000, { status: 'interrupted', reason: '开会', focusedMs: 10 * 60_000, endedAt: now - 3_000_000 }),
    focusAt(now - 2_000_000, { status: 'completed', focusedMs: 25 * 60_000 }),
  ]
  const stats = computeStats(records, now)

  assert.equal(stats.scope.today.completed, 1)
  assert.equal(stats.scope.today.interrupted, 1, 'the event is counted')
  assert.equal(stats.scope.today.aborted, 0, 'an event is not an abandoned run')
  // Exactly ONE pomodoro ended, so the rate is 100%, not 50%.
  assert.equal(stats.scope.today.completionRate, 100)
  assert.equal(stats.scope.today.totalRuns, 1, 'only ended pomodoros count as runs')
  // The event contributes NO time: the completion already owns the full 25.
  assert.equal(stats.scope.today.focusedMinutes, 25)
  assert.equal(stats.totalInterruptions, 1)
})

test('the interruption total includes both events and abandoned runs', () => {
  const now = new Date(2026, 9, 8, 12, 0, 0).getTime()
  const records = [
    focusAt(now - 3_600_000, { status: 'interrupted', reason: '开会', focusedMs: 5 * 60_000 }),
    focusAt(now - 2_400_000, { status: 'aborted', reason: '分心', focusedMs: 6 * 60_000 }),
    focusAt(now - 1_800_000, { status: 'completed' }),
  ]
  const stats = computeStats(records, now)
  assert.equal(stats.scope.today.interruptions, 2, 'the bucket exposes both kinds')
  assert.equal(stats.totalInterruptions, 2)
  assert.equal(stats.scope.today.aborted, 1)
  assert.equal(stats.scope.today.interrupted, 1)
  // Two ended runs (one aborted, one completed) -> 50%.
  assert.equal(stats.scope.today.completionRate, 50)
})

test('the reason breakdown explains interruptions, most frequent first', () => {
  const now = new Date(2026, 9, 8, 12, 0, 0).getTime()
  const records = [
    focusAt(now - 5_000_000, { status: 'interrupted', reason: '开会', focusedMs: 5 * 60_000 }),
    focusAt(now - 4_000_000, { status: 'interrupted', reason: '开会', focusedMs: 6 * 60_000 }),
    focusAt(now - 3_000_000, { status: 'aborted', reason: '分心', focusedMs: 7 * 60_000 }),
    // No reason recorded (a historic record, or a dismissed prompt).
    focusAt(now - 2_000_000, { status: 'interrupted', focusedMs: 4 * 60_000 }),
    // A completed run never appears in the reason log.
    focusAt(now - 1_000_000, { status: 'completed' }),
    // A skipped run is not an interruption either.
    focusAt(now - 500_000, { status: 'skipped', focusedMs: 60_000 }),
  ]
  const stats = computeStats(records, now)

  assert.equal(stats.reasons.length, 3)
  assert.deepEqual(
    stats.reasons.map((entry) => [entry.reason, entry.count, entry.known]),
    [
      ['开会', 2, true],
      ['分心', 1, true],
      [UNKNOWN_REASON, 1, false],
    ],
  )
  // Shares are over ALL interruptions, not just the ones that ended a run.
  const shareSum = stats.reasons.reduce((sum, entry) => sum + entry.sharePercent, 0)
  assert.ok(Math.abs(shareSum - 100) < 0.5, `shares should total ~100, got ${shareSum}`)
  assert.equal(stats.abortedWithReason, 3, 'three interruptions carried a chosen reason')
  assert.equal(stats.totalInterruptions, 4)
})

test('the reason log is empty-safe and omits non-interruptions', () => {
  const now = new Date(2026, 9, 8, 12, 0, 0).getTime()
  const stats = computeStats([focusAt(now - 3_600_000)], now)
  assert.deepEqual(stats.reasons, [])
  assert.equal(stats.totalInterruptions, 0)
  assert.equal(stats.abortedWithReason, 0)
})

test('computeStats window scoping excludes older records', () => {
  const now = new Date(2026, 9, 8, 12, 0, 0).getTime()
  const lastMonth = new Date(2026, 8, 20, 10, 0, 0).getTime()
  const stats = computeStats([focusAt(now - 3_600_000), focusAt(lastMonth)], now)
  assert.equal(stats.scope.today.completed, 1)
  assert.equal(stats.scope.month.completed, 1)
  assert.equal(stats.scope.total.completed, 2)
})

test('computeStats counts a streak and a recommended baseline', () => {
  const now = new Date(2026, 9, 8, 12, 0, 0).getTime()
  const records = []
  for (let i = 0; i < 3; i += 1) records.push(focusAt(now - i * 86_400_000 - 3_600_000))
  const stats = computeStats(records, now)
  assert.equal(stats.streakDays, 3)
  assert.ok(stats.baselineCompleted > 0)
  assert.equal(stats.days.length, 3)
})

test('computeStats is empty-safe', () => {
  const stats = computeStats([], Date.now())
  assert.equal(stats.scope.total.completed, 0)
  assert.equal(stats.scope.total.focusedMinutes, 0)
  assert.equal(stats.scope.total.completionRate, 0)
  assert.equal(stats.streakDays, 0)
  assert.deepEqual(stats.projects, [])
  assert.equal(stats.byHour.length, 24)
})

test('computeStats builds a dense year-long heatmap in week columns', () => {
  const now = new Date(2026, 9, 8, 12, 0, 0).getTime() // a Thursday
  const stats = computeStats([focusAt(now - 3_600_000)], now)
  const heat = stats.heatmap

  assert.equal(heat.columns.length, 53, 'a year is 53 week columns')
  for (const column of heat.columns) assert.equal(column.cells.length, 7, 'every column holds a full week')
  assert.equal(heat.cells.length, 53 * 7)

  const today = heat.cells.find((cell) => cell.date === '2026-10-08')
  assert.ok(today, 'today must appear in the grid')
  assert.equal(today.completed, 1)
  assert.equal(today.future, false)

  // The window is DENSE: days with no run still exist as zero cells.
  const blank = heat.cells.find((cell) => cell.completed === 0 && cell.future === false)
  assert.ok(blank, 'days without runs must still be present')

  // Cells past today are flagged, not counted.
  assert.ok(heat.cells.some((cell) => cell.future), 'the tail of the current week is in the future')
  assert.equal(heat.activeDays, 1)
  assert.equal(heat.totalCompleted, 1)

  // Every column reads MONDAY at the top and SUNDAY at the bottom.
  assert.equal(new Date(heat.columns[0].cells[0].time).getDay(), 1, 'first row is Monday')
  assert.equal(new Date(heat.columns[0].cells[6].time).getDay(), 0, 'last row is Sunday')
  // The grid opens exactly 53 weeks back on a Monday (2025-10-06), and the
  // current week's Monday sits in the FINAL column, above today.
  assert.equal(dayKey(heat.columns[0].cells[0].time), '2025-10-06')
  var lastColumn = heat.columns[heat.columns.length - 1]
  assert.equal(dayKey(lastColumn.cells[0].time), '2026-10-05')
  assert.equal(dayKey(lastColumn.cells[3].time), '2026-10-08', 'today sits mid-column')
})

test('the heatmap window reaches back about a year, and old runs land in it', () => {
  const now = new Date(2026, 9, 8, 12, 0, 0).getTime()
  const old = new Date(2025, 11, 25, 9, 0, 0).getTime()
  const stats = computeStats([focusAt(old), focusAt(now - 3_600_000)], now)
  const heat = stats.heatmap

  assert.equal(Math.round((heat.end - heat.start) / 86_400_000), 53 * 7 - 1)

  const cell = heat.cells.find((entry) => entry.date === dayKey(old))
  assert.ok(cell, 'a run from the previous year must fall inside the window')
  assert.equal(cell.completed, 1)
  assert.equal(heat.activeDays, 2)
})

test('the heatmap is DST-safe: every cell is one distinct calendar day', () => {
  // November 2026 covers a DST transition in many zones; a fixed 86_400_000 ms
  // stride would repeat or skip a date here.
  const now = new Date(2026, 10, 15, 12, 0, 0).getTime()
  const heat = computeStats([], now).heatmap
  const keys = heat.cells.map((cell) => cell.date)
  assert.equal(new Set(keys).size, keys.length, 'no calendar day may repeat')
  assert.deepEqual(keys, keys.slice().sort(), 'cells must be in ascending calendar order')
})

test('heatmap month labels are monotonic and sit on real columns', () => {
  const now = new Date(2026, 9, 8, 12, 0, 0).getTime()
  const heat = computeStats([], now).heatmap
  assert.ok(heat.months.length >= 11, `expected ~13 month labels, saw ${heat.months.length}`)
  let previous = -1
  for (const entry of heat.months) {
    assert.ok(entry.column > previous, 'month labels must advance')
    previous = entry.column
    assert.ok(entry.column < heat.columns.length, 'a label must sit on a real column')
    assert.ok(/^\d{1,2}月$/.test(entry.label), `unexpected label ${entry.label}`)
  }
})

test('heatmap is empty-safe', () => {
  const heat = computeStats([], Date.now()).heatmap
  assert.equal(heat.max, 0)
  assert.equal(heat.activeDays, 0)
  assert.equal(heat.totalCompleted, 0)
  assert.equal(heat.columns.length, 53)
})

test('filterByDateRange keeps an inclusive local-date window', () => {
  const records = [
    focusAt(new Date(2026, 9, 1, 9, 0, 0).getTime()),
    focusAt(new Date(2026, 9, 5, 9, 0, 0).getTime()),
    focusAt(new Date(2026, 9, 9, 9, 0, 0).getTime()),
  ]
  const scoped = filterByDateRange(records, '2026-10-01', '2026-10-05')
  assert.equal(scoped.length, 2)
  assert.equal(filterByDateRange(records, '', '').length, 3)
})

test('csvField quotes only when required', () => {
  assert.equal(csvField('plain'), 'plain')
  assert.equal(csvField('a,b'), '"a,b"')
  assert.equal(csvField('he said "hi"'), '"he said ""hi"""')
  assert.equal(csvField('line\nbreak'), '"line\nbreak"')
  assert.equal(csvField(' padded '), '" padded "')
  assert.equal(csvField(null), '')
  assert.equal(csvField(42), '42')
})

test('csvDocument starts with a UTF-8 BOM so Excel reads Chinese correctly', () => {
  const document = csvDocument([['项目', '分钟'], ['番茄钟', 25]])
  assert.ok(document.startsWith(UTF8_BOM))
  assert.ok(document.includes('项目,分钟'))
  assert.ok(document.endsWith('\r\n'))
  // No BOM when explicitly disabled.
  assert.ok(!csvDocument([['a']], { bom: false }).startsWith(UTF8_BOM))
})

test('toCsv joins rows with CRLF', () => {
  assert.equal(toCsv([['a', 'b'], ['c', 'd']]), 'a,b\r\nc,d')
})

test('recordRows emits one row per record, newest first, with both labels and codes', () => {
  const now = new Date(2026, 9, 8, 12, 0, 0).getTime()
  const rows = recordRows([focusAt(now - 3_600_000), focusAt(now, { status: 'aborted' })])
  assert.equal(rows.length, 3)
  assert.equal(rows[0][0], '开始时间')
  // Newest first.
  assert.equal(rows[1][5], '中断')
  assert.equal(rows[1][6], 'aborted')
  assert.equal(rows[2][6], 'completed')
  assert.equal(rows[2][3], '专注')
})

test('buildRecordsCsv contains all four sections and is Excel-openable', () => {
  const now = new Date(2026, 9, 8, 12, 0, 0).getTime()
  const records = [focusAt(now - 3_600_000)]
  const stats = computeStats(records, now)
  const text = buildRecordsCsv(records, stats, {
    dayKeyOf: dayKey,
    weekKeyOf: weekKey,
    rangeLabel: '全部记录',
    exportedAtText: formatLocalDateTime(now),
  })
  assert.ok(text.startsWith(UTF8_BOM))
  assert.ok(text.includes('指标,数值'))
  assert.ok(text.includes('日期,完成番茄数'))
  assert.ok(text.includes('项目,完成番茄数'))
  assert.ok(text.includes('开始时间,结束时间'))
  assert.ok(text.includes('累计完成番茄数,1'))
})

test('formatLocalDateTime and minutesOf render spreadsheet-friendly values', () => {
  const time = new Date(2026, 9, 8, 9, 5, 7).getTime()
  assert.equal(formatLocalDateTime(time), '2026-10-08 09:05:07')
  assert.equal(formatLocalDateTime(0), '')
  assert.equal(minutesOf(25 * 60_000), '25')
  assert.equal(minutesOf(90_000), '1.5')
  assert.equal(minutesOf(undefined), '0')
})
