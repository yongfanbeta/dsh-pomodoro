/**
 * End-to-end tests for the host half's HTTP surface.
 *
 * The plugin is installed into a stub Cordis context whose `webServer`
 * captures the registered route, so each test drives the real handler with a
 * real request/response pair instead of mocking the dispatcher.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply, name, inject } from '../lib/index.js'

/** Build a fake `req` stream carrying a JSON body. */
function makeRequest(method, url, body) {
  const text = body === undefined ? '' : JSON.stringify(body)
  const stream = Readable.from(text === '' ? [] : [Buffer.from(text, 'utf8')])
  stream.method = method
  stream.url = url
  stream.headers = { 'content-type': 'application/json' }
  return stream
}

/** Collect a fake `res`: status, headers and body text. */
function makeResponse() {
  const chunks = []
  const res = {
    status: 0,
    headers: {},
    writeHead(status, headers) {
      res.status = status
      res.headers = { ...res.headers, ...(headers ?? {}) }
      return res
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    },
    get text() {
      return Buffer.concat(chunks).toString('utf8')
    },
  }
  return res
}

/** Install the plugin against a stub host and return a request helper. */
async function withHost(run) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pomodoro-host-'))
  let route = null
  const session = { header: { cwd: join(home, 'projects', 'my-app') } }
  const ctx = {
    get(key) {
      if (key === 'sessions') return { get: (id) => (id === 's1' ? session : undefined) }
      if (key === 'sessionTitle') return { get: () => ({ title: '修复番茄钟' }) }
      if (key === 'workspaceRegistry') {
        return {
          list: () => [
            {
              id: 'w1',
              path: join(home, 'projects', 'my-app'),
              title: '我的应用',
              sessionIds: ['s1'],
            },
          ],
        }
      }
      return undefined
    },
    effect(factory) {
      const disposer = factory()
      return typeof disposer === 'function' ? disposer : () => undefined
    },
    webServer: {
      register(definition) {
        route = definition
        return () => {
          route = null
        }
      },
    },
  }

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    apply(ctx, { home })
    assert.ok(route !== null, 'plugin must register its route')

    const request = async (action, body, method = 'POST') => {
      const url = `/api/dsh-pomodoro/${action}`
      const res = makeResponse()
      await route.handler(makeRequest(method, url, body), res)
      let json = null
      if ((res.headers['content-type'] ?? '').includes('application/json')) {
        json = JSON.parse(res.text)
      }
      return { status: res.status, headers: res.headers, text: res.text, json }
    }

    return await run({ request, home, raw: route.handler })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
}

/** A valid record payload. */
function recordPayload(overrides = {}) {
  const startedAt = Date.now() - 25 * 60_000
  return {
    record: {
      project: '演示项目',
      source: 'manual',
      sessionId: '',
      phase: 'focus',
      status: 'completed',
      startedAt,
      endedAt: startedAt + 25 * 60_000,
      plannedMs: 25 * 60_000,
      focusedMs: 25 * 60_000,
      ...overrides,
    },
  }
}

test('plugin exports the identity the loader patch expects', () => {
  assert.equal(name, '@yongfanbeta/dsh-pomodoro')
  assert.ok(Array.isArray(inject) && inject.includes('webServer'))
})

test('state returns defaults, statistics and the store path on a fresh install', async () => {
  await withHost(async ({ request, home }) => {
    const { status, json } = await request('state')
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    assert.deepEqual(json.value.records, [])
    assert.equal(json.value.settings.focusMinutes, 25)
    assert.equal(json.value.stats.scope.total.completed, 0)
    assert.ok(json.value.storePath.startsWith(home))
    assert.deepEqual(json.value.recentProjects, [])
  })
})

test('record persists a run and returns refreshed statistics', async () => {
  await withHost(async ({ request }) => {
    const created = await request('record', recordPayload())
    assert.equal(created.status, 200)
    assert.equal(created.json.ok, true)
    assert.equal(created.json.value.stats.scope.today.completed, 1)
    assert.equal(created.json.value.stats.scope.today.focusedMinutes, 25)

    const reread = await request('state')
    assert.equal(reread.json.value.records.length, 1)
    assert.equal(reread.json.value.records[0].project, '演示项目')
    assert.equal(reread.json.value.recentProjects[0].project, '演示项目')
  })
})

test('record rejects a payload without a start time instead of inventing one', async () => {
  await withHost(async ({ request }) => {
    const { status, json } = await request('record', { record: { project: 'x' } })
    assert.equal(status, 400)
    assert.equal(json.ok, false)
    assert.equal(json.error.code, 'invalid-record')
  })
})

test('record falls back to the configured default project name', async () => {
  await withHost(async ({ request }) => {
    const blank = await request('record', recordPayload({ project: '   ' }))
    assert.equal(blank.json.value.record.project, '未命名项目')

    await request('settings', { settings: { defaultProject: '默认项目X' } })
    const named = await request('record', recordPayload({ project: '' }))
    assert.equal(named.json.value.record.project, '默认项目X')
  })
})

test('settings clamps hostile values and keeps unrelated fields', async () => {
  await withHost(async ({ request }) => {
    const { json } = await request('settings', { settings: { focusMinutes: 9999, autoStartNext: true } })
    assert.equal(json.value.settings.focusMinutes, 180)
    assert.equal(json.value.settings.autoStartNext, true)
    // Untouched fields keep their defaults.
    assert.equal(json.value.settings.shortBreakMinutes, 5)
  })
})

test('context resolves the workspace title and session title for a live session', async () => {
  await withHost(async ({ request }) => {
    const { json } = await request('context', { sessionId: 's1' })
    assert.equal(json.ok, true)
    assert.equal(json.value.project, '我的应用')
    assert.equal(json.value.title, '修复番茄钟')
    assert.ok(json.value.cwd.endsWith(join('projects', 'my-app')))
    const values = json.value.candidates.map((entry) => entry.value)
    assert.ok(values.includes('我的应用'))
    assert.ok(values.includes('修复番茄钟'))
  })
})

test('context degrades to an empty suggestion for an unknown session', async () => {
  await withHost(async ({ request }) => {
    const { json } = await request('context', { sessionId: 'nope' })
    assert.equal(json.ok, true)
    assert.equal(json.value.project, '')
    assert.equal(json.value.sessionId, 'nope')
  })
})

test('export returns an Excel-openable BOM-prefixed CSV attachment', async () => {
  await withHost(async ({ request }) => {
    await request('record', recordPayload())
    const exported = await request('export', undefined, 'GET')
    assert.equal(exported.status, 200)
    assert.ok(exported.headers['content-type'].startsWith('text/csv'))
    assert.ok(exported.headers['content-disposition'].includes('attachment'))
    assert.ok(exported.headers['content-disposition'].includes('.csv'))
    assert.ok(exported.text.startsWith('\uFEFF'), 'CSV must start with a UTF-8 BOM')
    assert.ok(exported.text.includes('演示项目'))
    assert.ok(exported.text.includes('累计完成番茄数,1'))
    assert.ok(exported.text.includes('日期,完成番茄数'))
  })
})

test('export honors a date window and excludes records outside it', async () => {
  await withHost(async ({ request }) => {
    const old = new Date(2020, 0, 15, 9, 0, 0).getTime()
    await request('record', recordPayload({ startedAt: old, endedAt: old + 1000, project: '很久以前' }))
    await request('record', recordPayload({ project: '今天' }))

    const today = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const key = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
    const scoped = await request(`export?from=${key}&to=${key}`, undefined, 'GET')
    assert.ok(scoped.text.includes('今天'))
    assert.ok(!scoped.text.includes('很久以前'))
  })
})

test('delete removes exactly one record', async () => {
  await withHost(async ({ request }) => {
    const first = await request('record', recordPayload({ project: 'A' }))
    const second = await request('record', recordPayload({ project: 'B' }))
    const target = second.json.value.record.id
    const after = await request('delete', { id: target })
    assert.equal(after.json.value.records.length, 1)
    assert.equal(after.json.value.records[0].project, 'A')
    assert.ok(first.json.value.record.id !== target)
  })
})

test('clear wipes the log but keeps settings', async () => {
  await withHost(async ({ request }) => {
    await request('settings', { settings: { focusMinutes: 45 } })
    await request('record', recordPayload())
    const cleared = await request('clear', {})
    assert.deepEqual(cleared.json.value.records, [])
    assert.equal(cleared.json.value.settings.focusMinutes, 45)
  })
})

test('clear with scope=range removes only the selected window', async () => {
  await withHost(async ({ request }) => {
    const old = new Date(2021, 5, 10, 9, 0, 0).getTime()
    await request('record', recordPayload({ startedAt: old, endedAt: old + 1000, project: '旧的' }))
    await request('record', recordPayload({ project: '新的' }))
    const cleared = await request('clear', { scope: 'range', from: '2021-06-01', to: '2021-06-30' })
    assert.equal(cleared.json.value.records.length, 1)
    assert.equal(cleared.json.value.records[0].project, '新的')
  })
})

test('mutating actions are POST-only so a prefetch cannot change state', async () => {
  await withHost(async ({ request }) => {
    const rejected = await request('record', recordPayload(), 'GET')
    assert.equal(rejected.status, 405)
    assert.equal(rejected.headers.allow, 'POST')

    // Nothing was written by the refused GET.
    const state = await request('state')
    assert.deepEqual(state.json.value.records, [])
  })
})

test('an unknown action answers 404 with a machine-readable code', async () => {
  await withHost(async ({ request }) => {
    const unknown = await request('nope', {})
    assert.equal(unknown.status, 404)
    assert.equal(unknown.json.ok, false)
    assert.equal(unknown.json.error.code, 'unknown-action')
  })
})

test('a malformed JSON body answers 400 instead of crashing the route', async () => {
  await withHost(async ({ raw }) => {
    const stream = Readable.from([Buffer.from('{ not json', 'utf8')])
    stream.method = 'POST'
    stream.url = '/api/dsh-pomodoro/settings'
    stream.headers = {}
    const res = makeResponse()
    await raw(stream, res)
    assert.equal(res.status, 400)
    const payload = JSON.parse(res.text)
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, 'bad-request')
  })
})

test('the route prefix also serves the bare /api/dsh-pomodoro path', async () => {
  await withHost(async ({ raw }) => {
    const stream = Readable.from([])
    stream.method = 'GET'
    stream.url = '/api/dsh-pomodoro'
    stream.headers = {}
    const res = makeResponse()
    await raw(stream, res)
    // Bare prefix resolves to `state`, which is GET-friendly.
    assert.equal(res.status, 200)
    assert.equal(JSON.parse(res.text).ok, true)
  })
})
