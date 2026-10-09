/**
 * dsh-pomodoro core: CSV export.
 *
 * RFC 4180 quoting plus a UTF-8 BOM, which is what makes Excel on Windows read
 * Chinese project names correctly when the file is opened by double-click.
 */

/** Excel opens a BOM-prefixed UTF-8 CSV in the right encoding on every locale. */
export const UTF8_BOM = '\uFEFF'

const CRLF = '\r\n'

/**
 * Quote one CSV field.
 *
 * A field is quoted when it contains a delimiter, a quote, a line break, or
 * leading/trailing whitespace; embedded quotes are doubled. `null`/`undefined`
 * become an empty field.
 */
export function csvField(value, delimiter = ',') {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'string' ? value : String(value)
  const needsQuote =
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r') ||
    text !== text.trim()
  if (!needsQuote) return text
  return `"${text.replace(/"/g, '""')}"`
}

/** Join rows into a CRLF-delimited CSV document (no BOM). */
export function toCsv(rows, delimiter = ',') {
  return rows.map((row) => row.map((cell) => csvField(cell, delimiter)).join(delimiter)).join(CRLF)
}

/** Full CSV document with a trailing newline, BOM optional. */
export function csvDocument(rows, { delimiter = ',', bom = true } = {}) {
  const body = toCsv(rows, delimiter)
  return `${bom ? UTF8_BOM : ''}${body}${CRLF}`
}

/** `YYYY-MM-DD HH:mm:ss` in local time — the format Excel parses unambiguously. */
export function formatLocalDateTime(timeMs) {
  if (!Number.isFinite(timeMs) || timeMs <= 0) return ''
  const d = new Date(timeMs)
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  )
}

/** Minutes with one decimal, as a plain number string for spreadsheets. */
export function minutesOf(ms) {
  // ms → minutes is /60000; rounding to one decimal is the same as
  // Math.round(ms / 6000) / 10, which avoids binary float dust in the CSV.
  return String(Math.round((Number(ms) || 0) / 6000) / 10)
}

/** Human phase label (the CSV keeps a stable machine key in its own column). */
const PHASE_LABELS = { focus: '专注', 'short-break': '短休息', 'long-break': '长休息' }
const STATUS_LABELS = { completed: '已完成', aborted: '中断', skipped: '跳过' }

/** Human label for a phase key, falling back to the raw key. */
export function phaseLabel(phase) {
  return PHASE_LABELS[phase] ?? phase
}

/** Human label for a status key, falling back to the raw key. */
export function statusLabel(status) {
  return STATUS_LABELS[status] ?? status
}

const RECORD_HEADER = [
  '开始时间',
  '结束时间',
  '项目',
  '阶段',
  '阶段代码',
  '状态',
  '状态代码',
  '计划时长(分钟)',
  '实际专注(分钟)',
  '日期',
  '周',
  '小时',
  '来源',
  '关联会话',
  '中断原因',
  '备注',
]

/**
 * One CSV row per record, newest first.
 *
 * Both a human label and the stable machine code are emitted so the file
 * survives being edited and re-imported by a spreadsheet.
 */
export function recordRows(records, { dayKeyOf, weekKeyOf } = {}) {
  const rows = [RECORD_HEADER]
  const sorted = records.slice().sort((a, b) => b.startedAt - a.startedAt)
  for (const record of sorted) {
    rows.push([
      formatLocalDateTime(record.startedAt),
      formatLocalDateTime(record.endedAt),
      record.project,
      phaseLabel(record.phase),
      record.phase,
      statusLabel(record.status),
      record.status,
      minutesOf(record.plannedMs),
      minutesOf(record.focusedMs),
      dayKeyOf ? dayKeyOf(record.startedAt) : '',
      weekKeyOf ? weekKeyOf(record.startedAt) : '',
      String(new Date(record.startedAt).getHours()),
      record.source,
      record.sessionId,
      // Empty for every status that never asks: only interruptions carry one.
      typeof record.reason === 'string' ? record.reason : '',
      record.note,
    ])
  }
  return rows
}

/** Per-day aggregate block. */
export function dayRows(days) {
  const rows = [['日期', '完成番茄数', '中断数', '跳过数', '专注时长(分钟)', '计划时长(分钟)', '完成率(%)']]
  for (const day of days) {
    rows.push([
      day.key,
      String(day.completed),
      String(day.aborted),
      String(day.skipped),
      String(day.focusedMinutes),
      String(day.plannedMinutes),
      String(day.completionRate),
    ])
  }
  return rows
}

/** Per-project aggregate block. */
export function projectRows(projects) {
  const rows = [['项目', '完成番茄数', '中断数', '跳过数', '专注时长(分钟)', '占比(%)']]
  for (const project of projects) {
    rows.push([
      project.project,
      String(project.completed),
      String(project.aborted),
      String(project.skipped),
      String(project.focusedMinutes),
      String(project.sharePercent),
    ])
  }
  return rows
}

/**
 * Interruption-reason block.
 *
 * `known` separates reasons the user actually chose from the historic runs that
 * predate the field, so a reader can tell "mostly distracted" from "mostly
 * unrecorded".
 */
export function reasonRows(reasons) {
  const rows = [['中断原因', '已记录', '次数', '中断前专注(分钟)', '占中断(%)']]
  for (const entry of reasons) {
    rows.push([
      entry.reason,
      entry.known ? '是' : '否',
      String(entry.count),
      String(entry.focusedMinutes),
      String(entry.sharePercent),
    ])
  }
  return rows
}

/** Overall totals block. */
export function summaryRows(scope, extra = {}) {
  const rows = [
    ['指标', '数值'],
    ['统计范围', extra.rangeLabel ?? '全部记录'],
    ['导出时间', extra.exportedAtText ?? ''],
    ['今日完成番茄数', String(scope.today.completed)],
    ['今日专注时长(分钟)', String(scope.today.focusedMinutes)],
    ['本周完成番茄数', String(scope.week.completed)],
    ['本周专注时长(分钟)', String(scope.week.focusedMinutes)],
    ['本月完成番茄数', String(scope.month.completed)],
    ['本月专注时长(分钟)', String(scope.month.focusedMinutes)],
    ['累计完成番茄数', String(scope.total.completed)],
    ['累计专注时长(分钟)', String(scope.total.focusedMinutes)],
    ['累计专注时长(小时)', String(Math.round((scope.total.focusedMinutes / 60) * 10) / 10)],
    ['累计中断次数', String(scope.total.aborted)],
    ['累计跳过次数', String(scope.total.skipped)],
  ]
  return rows
}

/**
 * Assemble the whole export: summary, per-day, per-project, interruption
 * reasons and the raw log.
 *
 * Sections are separated by a blank line so one file stays readable when a
 * user opens it in a text editor; each section repeats its own header.
 */
export function buildRecordsCsv(records, stats, options = {}) {
  const {
    dayKeyOf,
    weekKeyOf,
    rangeLabel,
    exportedAtText,
    sections = ['summary', 'days', 'projects', 'reasons', 'records'],
  } = options
  const blocks = []
  if (sections.includes('summary')) blocks.push(summaryRows(stats.scope, { rangeLabel, exportedAtText }))
  if (sections.includes('days')) blocks.push(dayRows(stats.days))
  if (sections.includes('projects')) blocks.push(projectRows(stats.projects))
  if (sections.includes('reasons') && Array.isArray(stats.reasons) && stats.reasons.length > 0) {
    blocks.push(reasonRows(stats.reasons))
  }
  if (sections.includes('records')) blocks.push(recordRows(records, { dayKeyOf, weekKeyOf }))
  const rows = []
  blocks.forEach((block, index) => {
    if (index > 0) rows.push([])
    rows.push(...block)
  })
  return csvDocument(rows)
}
