/**
 * dsh-pomodoro host half.
 *
 * The browser half owns the clock (it is the only place a user is looking),
 * and this half owns durability: it persists the pomodoro log under the
 * harness home, aggregates statistics, and serves both over the web carrier.
 * Routing through HTTP keeps the plugin dependency-free and mirrors how the
 * other installed third-party plugins talk to their host half.
 */

import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import { normalizeState, normalizeSettings, normalizeRecord } from './core/state.js'
import { JsonStore, stateFileIn, MAX_RECORDS } from './core/store.js'
import { computeStats, filterByDateRange, dayKey, weekKey } from './core/stats.js'
import { buildRecordsCsv, formatLocalDateTime } from './core/csv.js'

/** Cordis plugin name — must match the row name in cordis.patch.yml. */
export const name = 'dsh-pomodoro'

/** Services required by this plugin. */
export const inject = ['webServer']

/** Route prefix owned by this plugin. */
const BASE = '/api/dsh-pomodoro'

/** Body size ceiling for the small JSON payloads the client sends. */
const MAX_BODY_BYTES = 1024 * 1024

/**
 * Resolve the harness home the same way the rest of the product does:
 * an explicit plugin config wins, then `$DSH_HOME`, then `~/.dsh`.
 */
function resolveHome(config) {
  const configured = typeof config?.home === 'string' && config.home.trim() !== '' ? config.home.trim() : ''
  if (configured !== '') return resolve(configured)
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  if (fromEnv !== '') return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

/** Read and JSON-parse a request body, bounded and tolerant of an empty body. */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error('payload too large'), { status: 413 })
    chunks.push(buf)
  }
  if (total === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 })
  }
}

/** Write a JSON response. */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/**
 * Cap a source string to the closed vocabulary the UI understands, so a
 * hand-rolled request cannot poison the project-source column.
 */
const PROJECT_SOURCES = new Set(['session', 'workspace', 'recent', 'manual', 'default'])

/** Trim a user-supplied project name; empty becomes the configured default. */
function projectNameOf(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim().replace(/\s+/g, ' ')
  if (trimmed === '') return fallback
  return trimmed.slice(0, 120)
}

/**
 * Install the plugin.
 *
 * @param ctx - host context with `webServer` and (optionally) `sessions`,
 *   `workspaceRegistry` and `fs` for project suggestions.
 */
export function apply(ctx, config = {}) {
  const home = resolveHome(config)
  const store = new JsonStore(stateFileIn(home), (raw) => normalizeState(raw, { maxRecords: MAX_RECORDS }))

  /** Optional service probe — every consumer degrades instead of failing. */
  const maybe = (key) => {
    try {
      return ctx.get(key)
    } catch {
      return undefined
    }
  }

  /**
   * Suggest a project name for a session: prefer the workspace title that
   * owns the session, then the durable session title, then the working
   * directory's own basename. Every step is best-effort — a missing optional
   * service only shortens the suggestion.
   */
  const suggestForSession = (sessionId) => {
    const out = { sessionId: typeof sessionId === 'string' ? sessionId : '', cwd: '', project: '', title: '', candidates: [] }
    if (out.sessionId === '') return out
    const sessions = maybe('sessions')
    const session = sessions === undefined ? undefined : sessions.get(out.sessionId)
    const cwd = session?.header?.cwd
    if (typeof cwd === 'string' && cwd !== '') {
      out.cwd = cwd
      out.project = basename(cwd)
    }

    // Durable session title: the most human-readable name for "what I am on".
    if (session !== undefined) {
      const titles = maybe('sessionTitle')
      if (titles !== undefined) {
        try {
          const snapshot = titles.get(session)
          if (typeof snapshot?.title === 'string' && snapshot.title.trim() !== '') out.title = snapshot.title.trim()
        } catch {
          /* title folding is best-effort */
        }
      }
    }

    const registry = maybe('workspaceRegistry')
    if (registry !== undefined && out.cwd !== '') {
      try {
        for (const workspace of registry.list()) {
          const under =
            out.cwd === workspace.path ||
            out.cwd.startsWith(`${workspace.path}\\`) ||
            out.cwd.startsWith(`${workspace.path}/`)
          if (!under) continue
          if (out.project === '' || out.project === basename(out.cwd)) {
            // A workspace title names the project better than a folder name.
            if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(out.sessionId)) {
              out.project = workspace.title || out.project
            }
          }
          break
        }
      } catch {
        /* registry listing is best-effort */
      }
    }

    // Ordered candidates the UI offers as one-click defaults.
    if (out.project !== '') out.candidates.push({ value: out.project, source: 'workspace' })
    if (out.title !== '' && out.title !== out.project) out.candidates.push({ value: out.title, source: 'session' })
    return out
  }

  /** The shape every mutating endpoint returns: fresh state plus its statistics. */
  const stateView = (state, now = Date.now()) => ({
    version: state.version,
    settings: state.settings,
    records: state.records,
    stats: computeStats(state.records, now),
    storePath: store.path,
  })

  /** Distinct project names, most recently used first, for the picker. */
  const recentProjects = (records) => {
    const seen = new Map()
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const record = records[i]
      const key = record.project
      if (key === '' || seen.has(key)) continue
      seen.set(key, { project: key, lastAt: record.startedAt, count: 0 })
    }
    for (const record of records) {
      const entry = seen.get(record.project)
      if (entry !== undefined) entry.count += 1
    }
    return [...seen.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, 30)
  }

  /**
   * One request dispatcher. Keeps every endpoint on the same error envelope so
   * the browser half only needs one code path.
   */
  const handle = async (req, res, action, url) => {
    try {
      const state = await store.snapshot()

      switch (action) {
        case 'state': {
          sendJson(res, 200, {
            ok: true,
            value: {
              ...stateView(state),
              recentProjects: recentProjects(state.records),
            },
          })
          return
        }

        case 'context': {
          const body = await readJsonBody(req)
          sendJson(res, 200, { ok: true, value: suggestForSession(body.sessionId) })
          return
        }

        case 'record': {
          const body = await readJsonBody(req)
          const fallbackProject = state.settings.defaultProject
          const candidate = {
            ...body.record,
            project: projectNameOf(body.record?.project, fallbackProject),
            source: PROJECT_SOURCES.has(body.record?.source) ? body.record.source : 'manual',
          }
          const record = normalizeRecord(candidate)
          if (record === null) {
            sendJson(res, 400, { ok: false, error: { code: 'invalid-record', message: 'startedAt is required' } })
            return
          }
          const next = await store.update((current) => ({
            ...current,
            records: [...current.records, record].slice(-MAX_RECORDS),
          }))
          sendJson(res, 200, { ok: true, value: { record, ...stateView(next) } })
          return
        }

        case 'settings': {
          const body = await readJsonBody(req)
          const next = await store.update((current) => ({
            ...current,
            settings: normalizeSettings({ ...current.settings, ...(body.settings ?? {}) }),
          }))
          sendJson(res, 200, { ok: true, value: stateView(next) })
          return
        }

        case 'delete': {
          const body = await readJsonBody(req)
          const id = typeof body.id === 'string' ? body.id : ''
          const next = await store.update((current) => ({
            ...current,
            records: current.records.filter((record) => record.id !== id),
          }))
          sendJson(res, 200, { ok: true, value: stateView(next) })
          return
        }

        case 'clear': {
          const body = await readJsonBody(req)
          // `scope: 'range'` deletes only the selected window; anything else
          // wipes the log. Both keep settings untouched.
          const next = await store.update((current) => {
            if (body.scope === 'range') {
              const doomed = new Set(
                filterByDateRange(current.records, body.from, body.to).map((record) => record.id),
              )
              return { ...current, records: current.records.filter((record) => !doomed.has(record.id)) }
            }
            return { ...current, records: [] }
          })
          sendJson(res, 200, { ok: true, value: stateView(next) })
          return
        }

        case 'export': {
          const body = req.method === 'POST' ? await readJsonBody(req) : queryOf(url)
          const from = typeof body.from === 'string' ? body.from : ''
          const to = typeof body.to === 'string' ? body.to : ''
          const scoped = from === '' && to === '' ? state.records : filterByDateRange(state.records, from, to)
          const stats = computeStats(scoped)
          const text = buildRecordsCsv(scoped, stats, {
            dayKeyOf: dayKey,
            weekKeyOf: weekKey,
            rangeLabel: from === '' && to === '' ? '全部记录' : `${from || '最早'} ~ ${to || '至今'}`,
            exportedAtText: formatLocalDateTime(Date.now()),
          })
          const fileName = `pomodoro-${from || 'all'}_${to || 'now'}-${dayKey(Date.now())}.csv`
          res.writeHead(200, {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="${fileName}"`,
            'cache-control': 'no-store',
          })
          res.end(text)
          return
        }

        default:
          sendJson(res, 404, { ok: false, error: { code: 'unknown-action', message: action } })
      }
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500
      if (status >= 500) console.error('[dsh-pomodoro] request failed:', error)
      sendJson(res, status, {
        ok: false,
        error: { code: status === 500 ? 'internal-error' : 'bad-request', message: error?.message ?? String(error) },
      })
    }
  }

  const route = ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: BASE,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const action = url.pathname.slice(BASE.length).replace(/^\/+/, '').split('/')[0] || 'state'
        const method = req.method ?? 'GET'
        // Read-only actions accept GET (`state`) and the download form
        // (`export`); every mutation is POST-only so a prefetch cannot write.
        if (!GET_ACTIONS.has(action) && method !== 'POST') {
          res.writeHead(405, { allow: 'POST' })
          res.end('method not allowed')
          return
        }
        await handle(req, res, action, url)
      },
    }),
  )

  // Flush any queued write when the plugin unloads, so a reload cannot lose a
  // record that the browser already reported as saved.
  ctx.effect(() => () => {
    void store.drain()
  }, 'dsh-pomodoro: flush state on unload')

  return { store, route }
}

/**
 * Read-only actions reachable by GET. Everything else is POST-only so a
 * browser or proxy prefetch can never mutate the log.
 */
const GET_ACTIONS = new Set(['state', 'export'])

/** Query-string view for the GET form of the export and state actions. */
function queryOf(url) {
  const out = {}
  if (url === undefined || url === null || typeof url.searchParams?.get !== 'function') return out
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')
  if (typeof from === 'string' && from !== '') out.from = from
  if (typeof to === 'string' && to !== '') out.to = to
  return out
}

export { MAX_RECORDS }
