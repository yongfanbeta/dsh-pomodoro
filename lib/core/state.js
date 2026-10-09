/**
 * dsh-pomodoro core: schema, normalization, and defaults.
 *
 * Framework-free on purpose — the host half, the client half and the unit
 * tests all read the same declarations, so a stored file can never drift from
 * what the UI believes it may contain.
 */

/** Stored-file format version. Bumped whenever `records`/`settings` change shape. */
export const STATE_VERSION = 1

/** Focus-phase kinds a record may carry. Only `focus` counts toward statistics. */
export const PHASES = ['focus', 'short-break', 'long-break']

/**
 * Record statuses.
 *
 * `interrupted` is deliberately distinct from the outcome statuses: it marks an
 * interruption EVENT inside a pomodoro that the user resumed afterwards, not a
 * pomodoro that ended. Folding it into `aborted` would make a successfully
 * finished pomodoro count twice and halve its completion rate.
 */
export const STATUSES = ['completed', 'aborted', 'skipped', 'interrupted']

/** Statuses that describe how a pomodoro ENDED (completion-rate denominator). */
export const OUTCOME_STATUSES = ['completed', 'aborted', 'skipped']

/** Statuses that count as "being interrupted", for the 中断 total. */
export const INTERRUPT_STATUSES = ['interrupted', 'aborted']

/** Where the project name came from, kept for display and auditing. */
export const PROJECT_SOURCES = ['session', 'workspace', 'recent', 'manual', 'default']

/**
 * One-click interruption reasons.
 *
 * The list is short on purpose: a reason picker is used at the moment of
 * interruption, and a long menu would be slower than the interruption itself.
 * `custom` is the escape hatch, not a fourth preset.
 */
export const INTERRUPT_REASONS = Object.freeze([
  '被叫走',
  '开会',
  '临时任务',
  '接电话／回消息',
  '分心',
  '到点吃饭／休息',
  '其他',
])

/** Reasons in the preset list, as a Set for membership checks. */
const REASON_SET = new Set(INTERRUPT_REASONS)

/** Longest interruption note we persist. */
const MAX_REASON_LENGTH = 200

/**
 * Default plugin settings.
 *
 * `focusMinutes`/`shortBreakMinutes`/`longBreakMinutes` are the classic
 * 25/5/15 Pomodoro rhythm; `longBreakEvery` is how many completed focus runs
 * precede a long break.
 */
export const DEFAULT_SETTINGS = Object.freeze({
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  longBreakEvery: 4,
  /**
   * Start the break the moment a focus run completes. On by default: the
   * completion card announces it, and a break that waits for a click is a
   * break people forget to take.
   */
  autoStartBreak: true,
  /** Start the next focus run automatically when a break ends. Off by default. */
  autoStartNext: false,
  /** Persist an interrupted focus run as `aborted` instead of dropping it. */
  recordAborted: true,
  /** Persist break runs too (excluded from focus statistics either way). */
  recordBreaks: false,
  /** Play a short tone when a phase ends. */
  soundEnabled: false,
  /** Raise a system notification when a phase ends. */
  notifyEnabled: false,
  /** Show the in-app completion card when a phase ends. */
  cardEnabled: true,
  /** Project name used when neither a task nor a manual name is chosen. */
  defaultProject: '未命名项目',
  /** Show the running timer inside the sidebar icon. */
  showBadgeInSidebar: true,
  /** Ambient timer row under the composer, ahead of the session statistics. */
  showTimerInStatusBar: true,
  /**
   * Floating timer window: a small draggable always-on-top pill, bottom-right by
   * default, that mirrors the running timer so the clock is visible no matter
   * which panel is open. Off by default — it is an opt-in convenience.
   */
  showFloatingTimer: false,
  /** Persisted position of the floating window (px from top-left), or null = use default. */
  floatPosition: null,
  /** When true the floating window shows as a small draggable clock badge. */
  floatCollapsed: false,
  /**
   * Break-activity suggestions shown during a break (e.g. 深蹲十个、喝一杯水).
   * The user edits this list in Settings; each break picks one at random.
   */
  breakActivities: ['深蹲十个', '喝一杯水', '站起来拉伸', '闭眼休息 30 秒', '远眺放松眼睛'],
})

const MINUTE_MS = 60_000

/** Clamp a numeric setting into a sane, integer minute value. */
function clampMinutes(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** Clamp a numeric setting into a sane integer count. */
function clampCount(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** Coerce an arbitrary value to a boolean with an explicit default. */
function boolOf(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** Coerce an arbitrary value to a trimmed string with an explicit default. */
function textOf(value, fallback, maxLength = 120) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (trimmed === '') return fallback
  return trimmed.slice(0, maxLength)
}

/**
 * Merge an untrusted partial settings object over the defaults.
 * Unknown keys are dropped; every numeric field is clamped.
 */
export function normalizeSettings(input) {
  const raw = input !== null && typeof input === 'object' ? input : {}
  return {
    focusMinutes: clampMinutes(raw.focusMinutes, DEFAULT_SETTINGS.focusMinutes, 1, 180),
    shortBreakMinutes: clampMinutes(raw.shortBreakMinutes, DEFAULT_SETTINGS.shortBreakMinutes, 1, 60),
    longBreakMinutes: clampMinutes(raw.longBreakMinutes, DEFAULT_SETTINGS.longBreakMinutes, 1, 120),
    longBreakEvery: clampCount(raw.longBreakEvery, DEFAULT_SETTINGS.longBreakEvery, 1, 12),
    autoStartBreak: boolOf(raw.autoStartBreak, DEFAULT_SETTINGS.autoStartBreak),
    autoStartNext: boolOf(raw.autoStartNext, DEFAULT_SETTINGS.autoStartNext),
    recordAborted: boolOf(raw.recordAborted, DEFAULT_SETTINGS.recordAborted),
    recordBreaks: boolOf(raw.recordBreaks, DEFAULT_SETTINGS.recordBreaks),
    soundEnabled: boolOf(raw.soundEnabled, DEFAULT_SETTINGS.soundEnabled),
    notifyEnabled: boolOf(raw.notifyEnabled, DEFAULT_SETTINGS.notifyEnabled),
    cardEnabled: boolOf(raw.cardEnabled, DEFAULT_SETTINGS.cardEnabled),
    defaultProject: textOf(raw.defaultProject, DEFAULT_SETTINGS.defaultProject),
    showBadgeInSidebar: boolOf(raw.showBadgeInSidebar, DEFAULT_SETTINGS.showBadgeInSidebar),
    showTimerInStatusBar: boolOf(raw.showTimerInStatusBar, DEFAULT_SETTINGS.showTimerInStatusBar),
    showFloatingTimer: boolOf(raw.showFloatingTimer, DEFAULT_SETTINGS.showFloatingTimer),
    // floatPosition: an explicit {x,y} (both finite numbers ≥ 0) persists the
    // window's dragged location; anything else falls back to null (default corner).
    floatPosition:
      raw.floatPosition !== null &&
      typeof raw.floatPosition === 'object' &&
      Number.isFinite(Number(raw.floatPosition.x)) &&
      Number.isFinite(Number(raw.floatPosition.y)) &&
      Number(raw.floatPosition.x) >= 0 &&
      Number(raw.floatPosition.y) >= 0
        ? { x: Math.round(Number(raw.floatPosition.x)), y: Math.round(Number(raw.floatPosition.y)) }
        : null,
    floatCollapsed: boolOf(raw.floatCollapsed, DEFAULT_SETTINGS.floatCollapsed),
    // breakActivities: keep only non-empty trimmed strings, capped, de-duplicated,
    // and never empty — a blank list would leave a break with nothing to suggest.
    breakActivities: normalizeActivities(raw.breakActivities),
  }
}

/** Coerce an arbitrary value into a clean, non-empty list of break activities. */
const MAX_ACTIVITIES = 30
const MAX_ACTIVITY_LENGTH = 60
function normalizeActivities(value) {
  if (!Array.isArray(value)) return DEFAULT_SETTINGS.breakActivities.slice()
  const seen = new Set()
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim().replace(/\s+/g, ' ').slice(0, MAX_ACTIVITY_LENGTH)
    if (trimmed === '') continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
    if (out.length >= MAX_ACTIVITIES) break
  }
  return out.length > 0 ? out : DEFAULT_SETTINGS.breakActivities.slice()
}

/** Finite non-negative millisecond value, or `fallback`. */
function msOf(value, fallback = 0) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.round(n)
}

/** Finite epoch-millisecond timestamp, or `fallback`. */
function timeOf(value, fallback = 0) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.round(n)
}

/**
 * Normalize one stored record, or return `null` when it is unusable.
 * A record without a start time or a known phase is dropped rather than
 * repaired: statistics must never invent a data point.
 */
export function normalizeRecord(input) {
  if (input === null || typeof input !== 'object') return null
  const raw = input
  const startedAt = timeOf(raw.startedAt, 0)
  if (startedAt <= 0) return null
  const phase = PHASES.includes(raw.phase) ? raw.phase : 'focus'
  const plannedMs = msOf(raw.plannedMs, 0)
  const focusedMsRaw = msOf(raw.focusedMs, plannedMs)
  const endedAtRaw = timeOf(raw.endedAt, 0)
  const endedAt = endedAtRaw > 0 ? endedAtRaw : startedAt + focusedMsRaw
  const focusedMs = Math.min(focusedMsRaw, Math.max(0, endedAt - startedAt) + 1000)
  const status = STATUSES.includes(raw.status) ? raw.status : 'completed'
  const source = PROJECT_SOURCES.includes(raw.source) ? raw.source : 'manual'
  return {
    id: textOf(raw.id, `r-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, 64),
    project: textOf(raw.project, DEFAULT_SETTINGS.defaultProject),
    source,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId.slice(0, 128) : '',
    phase,
    status,
    startedAt,
    endedAt,
    plannedMs,
    focusedMs,
    reason: normalizeReason(raw.reason),
    note: typeof raw.note === 'string' ? raw.note.slice(0, 500) : '',
  }
}

/**
 * Normalize an interruption reason.
 *
 * A preset is stored verbatim; anything else is stored as free text (trimmed
 * and length-capped). An empty/absent reason is `''`, never `'其他'` — a run
 * whose reason was never asked for must not be reported as "other".
 */
export function normalizeReason(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().replace(/\s+/g, ' ')
  if (trimmed === '') return ''
  return trimmed.slice(0, MAX_REASON_LENGTH)
}

/** True when the value is one of the preset reasons. */
export function isPresetReason(value) {
  return REASON_SET.has(value)
}

/** Planned duration in ms for a phase under the given settings. */
export function plannedMsFor(settings, phase) {
  const minutes =
    phase === 'focus'
      ? settings.focusMinutes
      : phase === 'short-break'
        ? settings.shortBreakMinutes
        : settings.longBreakMinutes
  return minutes * MINUTE_MS
}

/** Empty state with defaults applied. */
export function emptyState() {
  return { version: STATE_VERSION, settings: normalizeSettings(undefined), records: [] }
}

/**
 * Normalize a whole stored file. Unknown versions are still read (records are
 * validated individually), so a downgrade loses settings but never the log.
 */
export function normalizeState(input, { maxRecords = 20000 } = {}) {
  const raw = input !== null && typeof input === 'object' ? input : {}
  const list = Array.isArray(raw.records) ? raw.records : []
  const records = []
  for (const entry of list) {
    const record = normalizeRecord(entry)
    if (record !== null) records.push(record)
  }
  records.sort((a, b) => a.startedAt - b.startedAt)
  const trimmed = records.length > maxRecords ? records.slice(records.length - maxRecords) : records
  return {
    version: STATE_VERSION,
    settings: normalizeSettings(raw.settings),
    records: trimmed,
  }
}

export { MINUTE_MS }
