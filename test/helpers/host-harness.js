/**
 * A stub Cordis host for the pomodoro plugin.
 *
 * `webServer.register` captures the real route, so tests drive the shipped
 * handler with genuine request/response streams instead of mocking dispatch.
 * Optional services are stubbed to describe a Session in a workspace.
 */

import { strict as assert } from 'node:assert'
import { Readable } from 'node:stream'
import { join } from 'node:path'

import { apply } from '../../lib/index.js'

/** Build a fake `req` stream carrying an optional JSON body. */
export function makeRequest(method, url, body) {
  const text = body === undefined ? '' : JSON.stringify(body)
  const stream = Readable.from(text === '' ? [] : [Buffer.from(text, 'utf8')])
  stream.method = method
  stream.url = url
  stream.headers = { 'content-type': 'application/json' }
  return stream
}

/** Collect a fake `res`: status, headers and body text. */
export function makeResponse() {
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

/**
 * Install the plugin against a stub host.
 *
 * @returns the request helper, the raw route handler, and the captured route.
 */
export function createHostHarness({ home, cwd, workspaceTitle = '我的应用', sessionTitle = '修复番茄钟' } = {}) {
  const projectCwd = cwd ?? join(home, 'projects', 'my-app')
  const session = { header: { cwd: projectCwd } }
  let captured = null

  const ctx = {
    get(key) {
      if (key === 'sessions') return { get: (id) => (id === 's1' ? session : undefined) }
      if (key === 'sessionTitle') return { get: () => ({ title: sessionTitle }) }
      if (key === 'workspaceRegistry') {
        return {
          list: () => [{ id: 'w1', path: projectCwd, title: workspaceTitle, sessionIds: ['s1'] }],
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
        captured = definition
        return () => {
          captured = null
        }
      },
    },
  }

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    apply(ctx, { home })
    assert.ok(captured !== null, 'plugin must register its route')

    const request = async (action, body, method = 'POST') => {
      const res = makeResponse()
      await captured.handler(makeRequest(method, `/api/dsh-pomodoro/${action}`, body), res)
      let json = null
      const contentType = res.headers['content-type'] ?? ''
      if (contentType.includes('application/json')) json = JSON.parse(res.text)
      return { status: res.status, headers: res.headers, text: res.text, json }
    }

    return {
      request,
      raw: captured.handler,
      route: captured,
      get routeRemoved() {
        return captured === null
      },
      restore() {
        if (previousHome === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previousHome
      },
    }
  } catch (error) {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    throw error
  }
}
