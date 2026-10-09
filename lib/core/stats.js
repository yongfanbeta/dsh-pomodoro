/**
 * dsh-pomodoro core: statistics aggregation.
 *
 * Pure functions over normalized records. A "focus record" is a `focus`-phase
 * entry whose status is `completed`; interrupted and skipped runs are counted
 * separately so they can never inflate the completed totals.
 */

/** Local-calendar day key, `YYYY-MM-DD`, in the host's time zone. */
export function dayKey(timeMs) {
  const d = new Date(timeMs)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Local-calendar month key, `YYYY-MM`. */
export function monthKey(timeMs) {
  const d = new Date(timeMs)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** Week key `YYYY-Www` (ISO-8601 week, Monday-based). */
export function weekKey(timeMs) {
  const d = new Date(timeMs)
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  // ISO: Thursday of this week decides the year.
  const dayNum = (target.getDay() + 6) % 7
  target.setDate(target.getDate() - dayNum + 3)
  const firstThursday = new Date(target.getFullYear(), 0, 4)
  const firstDayNum = (firstThursday.getDay() + 6) % 7
  firstThursday.setDate(firstThursday.getDate() - firstDayNum + 3)
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86_400_000))
  return `${target.getFullYear()}-W${String(week).padStart(2, '0')}`
}

/** Monday 00:00 local time of the week containing `timeMs`. */
export function startOfWeek(timeMs) {
  const d = new Date(timeMs)
  d.setHours(0, 0, 0, 0)
  const dayNum = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - dayNum)
  return d.getTime()
}

/** Local midnight of the day containing `timeMs`. */
export function startOfDay(timeMs) {
  const d = new Date(timeMs)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** First instant of the calendar month containing `timeMs`. */
export function startOfMonth(timeMs) {
  const d = new Date(timeMs)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

/**
 * Bucket label for an aborted run that was never asked (or gave) a reason.
 * Historic records predate the reason field, so they legitimately land here.
 */
export const UNKNOWN_REASON = '未记录原因'

/** Empty mutable accumulator for one grouping key. */
function bucket(key) {
  return {
    key,
    completed: 0,
    aborted: 0,
    skipped: 0,
    /** Interruption EVENTS inside pomodoros that were resumed afterwards. */
    interrupted: 0,
    focusedMs: 0,
    plannedMs: 0,
  }
}

/**
 * Fold a run into a bucket.
 *
 * `interrupted` records contribute no time: they are events inside a pomodoro
 * whose outcome record already carries the full focused time. Counting both
 * would inflate "focused today" beyond the clock.
 */
function add(bucketValue, record) {
  if (record.status === 'completed') bucketValue.completed += 1
  else if (record.status === 'aborted') bucketValue.aborted += 1
  else if (record.status === 'interrupted') bucketValue.interrupted += 1
  else bucketValue.skipped += 1
  if (record.status !== 'interrupted') {
    bucketValue.focusedMs += record.focusedMs
    bucketValue.plannedMs += record.plannedMs
  }
}

/** Round to one decimal place, avoiding `-0` and float dust. */
function round1(value) {
  return Math.round(value * 10) / 10
}

/** Finalize one bucket for the wire: minutes instead of raw milliseconds. */
function finalize(bucketValue) {
  // Completion rate divides by ENDED pomodoros only: an interruption event
  // inside a resumed pomodoro is not a separate attempt, so counting it would
  // penalise the user twice for one distraction.
  const ended = bucketValue.completed + bucketValue.aborted + bucketValue.skipped
  return {
    key: bucketValue.key,
    completed: bucketValue.completed,
    aborted: bucketValue.aborted,
    skipped: bucketValue.skipped,
    interrupted: bucketValue.interrupted,
    /** Every interruption, whether it ended the pomodoro or not. */
    interruptions: bucketValue.interrupted + bucketValue.aborted,
    totalRuns: ended,
    focusedMinutes: round1(bucketValue.focusedMs / 60_000),
    plannedMinutes: round1(bucketValue.plannedMs / 60_000),
    completionRate: ended === 0 ? 0 : Math.round((bucketValue.completed / ended) * 1000) / 10,
  }
}

/**
 * Build the complete statistics payload for the UI.
 *
 * @param records - normalized records, any order.
 * @param now - reference instant (injectable for tests).
 */
export function computeStats(records, now = Date.now()) {
  const focusRecords = records.filter((r) => r.phase === 'focus')
  const todayStart = startOfDay(now)
  const weekStart = startOfWeek(now)
  const monthStart = startOfMonth(now)
  const today = dayKey(now)
  const week = weekKey(now)
  const month = monthKey(now)

  const scope = { today: bucket(today), week: bucket(week), month: bucket(month), total: bucket('total') }
  const byDay = new Map()
  const byProject = new Map()
  const byHour = new Array(24).fill(0)

  for (const record of focusRecords) {
    const at = record.startedAt
    const key = dayKey(at)

    let day = byDay.get(key)
    if (day === undefined) {
      day = bucket(key)
      byDay.set(key, day)
    }
    add(day, record)

    let project = byProject.get(record.project)
    if (project === undefined) {
      project = bucket(record.project)
      byProject.set(record.project, project)
    }
    add(project, record)

    if (record.status === 'completed') byHour[new Date(at).getHours()] += 1

    add(scope.total, record)
    if (at >= monthStart) add(scope.month, record)
    if (at >= weekStart) add(scope.week, record)
    if (at >= todayStart) add(scope.today, record)
  }

  const days = [...byDay.values()].sort((a, b) => (a.key < b.key ? -1 : 1)).map(finalize)
  const projects = [...byProject.values()]
    .sort((a, b) => b.focusedMs - a.focusedMs || (a.key < b.key ? -1 : 1))
    .map((entry) => ({
      ...finalize(entry),
      project: entry.key,
      sharePercent: scope.total.focusedMs === 0 ? 0 : Math.round((entry.focusedMs / scope.total.focusedMs) * 1000) / 10,
    }))

  // Interruption reasons: every interruption asks, whether it ended the
  // pomodoro (`aborted`) or merely paused it (`interrupted`). Skipped runs
  // never ask, so folding them in would report every skip as "unexplained".
  const reasonCounts = new Map()
  let abortedWithReason = 0
  for (const record of focusRecords) {
    if (record.status !== 'aborted' && record.status !== 'interrupted') continue
    const reason = typeof record.reason === 'string' && record.reason !== '' ? record.reason : ''
    const key = reason === '' ? UNKNOWN_REASON : reason
    if (reason !== '') abortedWithReason += 1
    const entry = reasonCounts.get(key) ?? { reason: key, count: 0, focusedMs: 0, known: reason !== '' }
    entry.count += 1
    entry.focusedMs += record.focusedMs
    reasonCounts.set(key, entry)
  }
  // The denominator is every interruption, not just the ones that ended a run.
  let totalInterruptions = 0
  for (const record of focusRecords) {
    if (record.status === 'aborted' || record.status === 'interrupted') totalInterruptions += 1
  }
  const reasons = [...reasonCounts.values()]
    .sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1))
    .slice(0, 20)
    .map((entry) => ({
      reason: entry.reason,
      known: entry.known,
      count: entry.count,
      focusedMinutes: round1(entry.focusedMs / 60_000),
      sharePercent: totalInterruptions === 0 ? 0 : Math.round((entry.count / totalInterruptions) * 1000) / 10,
    }))

  const records3 = focusRecords.slice().sort((a, b) => b.startedAt - a.startedAt)

  return {
    now,
    today,
    week,
    month,
    scope: {
      today: finalize(scope.today),
      week: finalize(scope.week),
      month: finalize(scope.month),
      total: finalize(scope.total),
    },
    /** Per-day series, ascending; the UI slices the tail it wants. */
    days,
    /** Recommended daily target, derived from the observed habit (never zero). */
    baselineCompleted: averageCompleted(days, now),
    projects,
    /** Completed focus runs per local hour of day. */
    byHour,
    /** Streak of consecutive days with at least one completed focus run. */
    streakDays: computeStreak(days, now),
    /** Why focus runs were interrupted, most frequent first. */
    reasons,
    /** How many interruptions carried a reason the user actually chose. */
    abortedWithReason,
    /** Every interruption (event or ending) over all time. */
    totalInterruptions,
    /** GitHub-style contribution calendar: dense days + week columns. */
    heatmap: buildHeatmap(days, now),
    lastRunAt: records3.length === 0 ? 0 : records3[0].endedAt,
  }
}

/**
 * GitHub-style contribution calendar over the trailing year.
 *
 * The day series is DENSE — every calendar day appears, including days with no
 * run — because a heatmap's meaning comes from its gaps as much as its blocks.
 * Days are laid out in week columns, each column reading MONDAY at the top down
 * to SUNDAY, padded so the first column starts on the week boundary and the
 * last ends on it. Monday-first is how the per-day chart labels its columns.
 */
export function buildHeatmap(days, now, { weeks = 53 } = {}) {
  const byKey = new Map(days.map((day) => [day.key, day]))
  // The grid ends on the SUNDAY of the current week, so every column is seven
  // rows tall (Mon..Sun) and today sits inside the final column. Day arithmetic
  // goes through `setDate`, which is DST-safe: adding 86_400_000 ms across a
  // transition would repeat or skip a calendar day.
  const todayStart = new Date(startOfDay(now))
  const isoDow = (todayStart.getDay() + 6) % 7
  const lastColEnd = new Date(todayStart)
  // The coming Sunday closes the current Monday-first week.
  lastColEnd.setDate(lastColEnd.getDate() + (6 - isoDow))
  const totalDays = weeks * 7
  const firstDay = new Date(lastColEnd)
  firstDay.setDate(firstDay.getDate() - (totalDays - 1))
  const todayTime = todayStart.getTime()

  const cells = []
  const columns = []
  let max = 0
  for (let index = 0; index < totalDays; index += 1) {
    const cursor = new Date(firstDay)
    cursor.setDate(cursor.getDate() + index)
    const time = cursor.getTime()
    const key = dayKey(time)
    const entry = byKey.get(key)
    const completed = entry === undefined ? 0 : entry.completed
    const focusedMinutes = entry === undefined ? 0 : entry.focusedMinutes
    if (completed > max) max = completed
    const cell = { date: key, time, completed, focusedMinutes, future: time > todayTime }
    cells.push(cell)
    const columnIndex = Math.floor(index / 7)
    if (columns.length <= columnIndex) columns.push({ index: columnIndex, cells: [] })
    columns[columnIndex].cells.push(cell)
  }

  // A month label rides the first column whose week begins in a new month.
  const months = []
  let lastMonth = ''
  for (const column of columns) {
    const stamp = new Date(column.cells[0].time)
    const monthOfColumn = `${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, '0')}`
    if (monthOfColumn !== lastMonth) {
      lastMonth = monthOfColumn
      months.push({ column: column.index, label: `${stamp.getMonth() + 1}月` })
    }
  }

  let activeDays = 0
  let totalCompleted = 0
  for (const cell of cells) {
    if (cell.future) continue
    if (cell.completed > 0) activeDays += 1
    totalCompleted += cell.completed
  }

  return {
    cells,
    columns,
    months,
    max,
    weeks,
    activeDays,
    totalCompleted,
    start: firstDay.getTime(),
    end: lastColEnd.getTime(),
  }
}

/** Mean completed runs over the last 14 calendar days ending today. */
function averageCompleted(days, now) {
  const byKey = new Map(days.map((d) => [d.key, d]))
  let sum = 0
  for (let i = 0; i < 14; i += 1) {
    const key = dayKey(startOfDay(now) - i * 86_400_000)
    sum += byKey.get(key)?.completed ?? 0
  }
  return Math.round((sum / 14) * 10) / 10
}

/** Consecutive days ending today (or yesterday) that carry a completed run. */
function computeStreak(days, now) {
  const withRuns = new Set(days.filter((d) => d.completed > 0).map((d) => d.key))
  let cursor = startOfDay(now)
  if (!withRuns.has(dayKey(cursor))) {
    cursor -= 86_400_000
    if (!withRuns.has(dayKey(cursor))) return 0
  }
  let streak = 0
  while (withRuns.has(dayKey(cursor))) {
    streak += 1
    cursor -= 86_400_000
  }
  return streak
}

/** Filter records to an inclusive local-date window (`YYYY-MM-DD` strings). */
export function filterByDateRange(records, from, to) {
  return records.filter((record) => {
    const key = dayKey(record.startedAt)
    if (typeof from === 'string' && from !== '' && key < from) return false
    if (typeof to === 'string' && to !== '' && key > to) return false
    return true
  })
}
