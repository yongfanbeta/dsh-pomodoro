/**
 * A tiny DOM + module-loader harness.
 *
 * It exists so the shipped client bundle can be really evaluated, mounted and
 * rendered in a plain Node test: `window.__ModuleLoader__.load` collects the
 * factory, the factory receives a `require` backed by the mini React runtime,
 * and a minimal document/localStorage make the bundle's side effects work.
 *
 * It is intentionally not a browser emulator.
 */

import { Readable } from 'node:stream'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createMiniReact } from './mini-react.js'

/** Absolute path of the shipped client bundle under test. */
const BUNDLE_PATH = fileURLToPath(new URL('../../lib/client.js', import.meta.url))

/** Bust the ESM cache so every harness re-evaluates the bundle for real. */
let evaluationCounter = 0

/** Minimal element used by the bundle's style insertion and download link. */
function createElement(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    attributes: {},
    textContent: '',
    appendChild(child) {
      this.children.push(child)
      return child
    },
    remove() {
      /* nothing holds a parent pointer in this harness */
    },
    setAttribute(name, value) {
      this.attributes[name] = value
    },
    addEventListener() {},
    removeEventListener() {},
    click() {
      this.clicked = true
    },
  }
}

/** Build the harness: fake globals, a bridge to the host route, and a loader. */
export function createClientHarness(options = {}) {
  const mini = createMiniReact()
  const styleTags = []
  const links = []
  const calls = []

  const document = {
    head: {
      appendChild(node) {
        styleTags.push(node)
        return node
      },
    },
    body: {
      appendChild(node) {
        if (node.tagName === 'A') links.push(node)
        return node
      },
    },
    createElement(tag) {
      return createElement(tag)
    },
    querySelector(selector) {
      const match = /data-plugin-css="([^"]+)"/.exec(String(selector))
      if (match !== null) {
        const wanted = JSON.parse(`"${match[1]}"`)
        return styleTags.find((tag) => tag.dataset.pluginCss === wanted) ?? null
      }
      return null
    },
    querySelectorAll() {
      return []
    },
    addEventListener() {},
    removeEventListener() {},
  }

  /**
   * Browser storage. A caller may pass a shared `Map` so two harnesses model
   * two page loads over the same origin.
   */
  const storage = options.mirror instanceof Map ? options.mirror : new Map()
  const localStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null
    },
    setItem(key, value) {
      storage.set(key, String(value))
    },
    removeItem(key) {
      storage.delete(key)
    },
  }

  /** Convert a client `fetch` call into a request against the host route. */
  async function fetchImpl(url, init) {
    const method = (init && init.method) || 'GET'
    const bodyText = init && typeof init.body === 'string' ? init.body : ''
    calls.push({ url: String(url), method, body: bodyText })

    if (typeof options.route !== 'function') {
      return {
        ok: false,
        status: 503,
        async json() {
          return { ok: false, error: { code: 'no-route', message: 'host route not wired' } }
        },
        async text() {
          return ''
        },
      }
    }

    const [path, query] = String(url).split('?')
    const stream = Readable.from(bodyText === '' ? [] : [Buffer.from(bodyText, 'utf8')])
    stream.method = method
    stream.url = query === undefined ? path : `${path}?${query}`
    stream.headers = (init && init.headers) || {}

    const chunks = []
    let status = 0
    const headers = {}
    const res = {
      writeHead(nextStatus, nextHeaders) {
        status = nextStatus
        Object.assign(headers, nextHeaders ?? {})
        return res
      },
      end(chunk) {
        if (chunk !== undefined && chunk !== null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      },
    }
    await options.route(stream, res)

    const text = Buffer.concat(chunks).toString('utf8')
    return {
      ok: status >= 200 && status < 300,
      status,
      headers,
      async json() {
        return JSON.parse(text)
      },
      async text() {
        return text
      },
    }
  }

  const modules = new Map()
  const registrations = []

  const window = {
    __ModuleLoader__: {
      load(definition) {
        registrations.push(definition)
        modules.set(definition.id, definition)
      },
    },
    localStorage,
    document,
    confirm: () => options.confirm !== false,
  }

  const globals = ['window', 'document', 'localStorage', 'fetch', 'Notification']
  const previous = {}
  for (const key of globals) previous[key] = globalThis[key]

  /**
   * `navigator` is a getter-only global on modern Node, so it needs a
   * descriptor write rather than an assignment; the bundle only reads it.
   */
  const hadNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

  /** Controllable clock and interval table. The bundle drives its countdown
   * from `Date.now()` and `setInterval`, so owning both lets a test finish a
   * 25-minute pomodoro in one synchronous step. */
  const clock = { now: options.now ?? Date.now(), intervals: new Map(), nextId: 1 }
  const realDateNow = Date.now
  Date.now = () => clock.now
  globalThis.setInterval = (fn, delay) => {
    const id = clock.nextId
    clock.nextId += 1
    clock.intervals.set(id, { fn, delay })
    return id
  }
  globalThis.clearInterval = (id) => {
    clock.intervals.delete(id)
  }

  /** Move the clock forward and fire every registered interval once. */
  function advance(ms) {
    clock.now += ms
    for (const entry of [...clock.intervals.values()]) entry.fn()
  }

  /** Fire the registered intervals without moving the clock. */
  function fireIntervals() {
    for (const entry of [...clock.intervals.values()]) entry.fn()
  }

  globalThis.window = window
  globalThis.document = document
  globalThis.localStorage = localStorage
  globalThis.fetch = fetchImpl
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'dsh-pomodoro-test' },
      configurable: true,
      writable: true,
    })
  } catch (error) {
    /* a locked-down runtime keeps its own navigator; nothing here needs it */
  }

  /** Evaluate the bundle and return the plugin object it registered. */
  function loadBundle() {
    const definition = registrations[registrations.length - 1] ?? modules.get('dsh-pomodoro')
    if (definition === undefined) throw new Error('bundle did not call __ModuleLoader__.load')
    const require = (spec) => {
      if (spec === 'react') return mini.React
      throw new Error(`unexpected require("${spec}") in the client bundle`)
    }
    return definition.factory(require)
  }

  /**
   * Really execute `lib/client.js`. The module cache is defeated with a
   * counter so each test gets a virgin evaluation (fresh module-level store).
   */
  async function evaluateBundle() {
    evaluationCounter += 1
    const url = `${pathToFileURL(BUNDLE_PATH).href}?dshp-eval=${evaluationCounter}`
    await import(url)
    if (registrations.length === 0) {
      throw new Error(`bundle at ${BUNDLE_PATH} never called window.__ModuleLoader__.load`)
    }
  }

  /** Sanity-check the bundle source is present before evaluating it. */
  async function assertBundleExists() {
    const source = await readFile(BUNDLE_PATH, 'utf8')
    if (!source.includes('__ModuleLoader__.load')) throw new Error('client bundle is missing its loader call')
    return source
  }

  /** The slots registry double: records what the plugin registers. */
  function createSlots() {
    const entries = new Map()
    const slots = {
      register(definition, component) {
        entries.set(`${definition.name}:${definition.key ?? definition.id}`, { definition, component })
        return () => entries.delete(`${definition.name}:${definition.key ?? definition.id}`)
      },
      inject(key, callback) {
        const disposer = callback()
        return typeof disposer === 'function' ? disposer : () => undefined
      },
    }
    return { slots, entries }
  }

  /** Evaluate the bundle, install it into a stub context, and report entries. */
  async function mount() {
    await assertBundleExists()
    await evaluateBundle()
    const plugin = loadBundle()
    const { slots, entries } = createSlots()
    const disposers = []
    const ctx = {
      slots,
      effect(factory, label) {
        const disposer = factory()
        void label
        if (typeof disposer === 'function') disposers.push(disposer)
        return () => undefined
      },
    }
    plugin.apply(ctx)
    return {
      plugin,
      entries,
      disposers,
      dispose() {
        while (disposers.length > 0) {
          const disposer = disposers.pop()
          try {
            disposer()
          } catch (error) {
            /* a failing disposer must not mask the assertion that follows */
          }
        }
      },
    }
  }

  function restore() {
    Date.now = realDateNow
    for (const key of globals) {
      if (previous[key] === undefined) delete globalThis[key]
      else globalThis[key] = previous[key]
    }
    if (hadNavigator === undefined) delete globalThis.navigator
    else Object.defineProperty(globalThis, 'navigator', hadNavigator)
  }

  /**
   * Drain microtasks and pending timers.
   *
   * Called between disposing the plugin and restoring the globals, so an async
   * continuation that a broken teardown failed to stop surfaces here as a real
   * error rather than being silently swallowed by a restored `fetch`.
   */
  async function settlePending(rounds = 6) {
    for (let i = 0; i < rounds; i += 1) {
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  return {
    mini,
    mount,
    restore,
    settlePending,
    clock,
    advance,
    fireIntervals,
    calls,
    links,
    styleTags,
    storage,
    window,
    document,
  }
}
