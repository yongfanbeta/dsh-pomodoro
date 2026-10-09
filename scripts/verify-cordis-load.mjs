/**
 * Load the plugin through the real Cordis framework.
 *
 * The other suites exercise the plugin against purpose-built doubles. This one
 * mounts it into an actual `@deepseek-ai/cordis` app, so service injection,
 * `ctx.effect` lifetime and disposal are the framework's own behaviour rather
 * than a stub's approximation.
 *
 * Usage:
 *   node scripts/verify-cordis-load.mjs [profileName]
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileName = process.argv[2] ?? 'web'
const profileDir = join(dshHome, 'profiles', profileName)
const profilesRoot = join(dshHome, 'profiles')

// Resolve through the profile's own node_modules, exactly as the loader does.
const cordisUrl = pathToFileURL(join(profilesRoot, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')).href
const { Context } = await import(cordisUrl)
const pluginUrl = pathToFileURL(join(profileDir, 'node_modules', '@yongfanbeta/dsh-pomodoro', 'lib', 'index.js')).href
const plugin = await import(pluginUrl)

let failures = 0
const log = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  ${detail}`}`)
  if (!ok) failures += 1
}

// --- build a real Cordis app with a stub webServer ---------------------------
const app = new Context()
const registered = []
const disposed = []

// A service is only injectable once something provides it; the real profile
// gets `webServer` from dsh-host-webserver, which would bind a port here.
app.provide('webServer', {
  register(route) {
    registered.push(route)
    return () => {
      const index = registered.indexOf(route)
      if (index >= 0) registered.splice(index, 1)
      disposed.push(route)
    }
  },
})

log(true, 'real @deepseek-ai/cordis Context created')

// --- mount the plugin -------------------------------------------------------
const fiber = app.plugin(plugin)
await fiber
log(true, 'plugin mounted into the real framework without throwing')

log(registered.length === 1, 'exactly one webServer route registered', registered[0]?.path ?? '(none)')
log(registered[0]?.kind === 'prefix', 'route is a prefix route', String(registered[0]?.kind))
log(registered[0]?.path === '/api/dsh-pomodoro', 'route path is /api/dsh-pomodoro', String(registered[0]?.path))

// --- the route really serves, over a real Node stream ------------------------
const { Readable } = await import('node:stream')
const request = Readable.from([])
request.method = 'GET'
request.url = '/api/dsh-pomodoro'
request.headers = {}

const chunks = []
let status = 0
const headers = {}
const response = {
  writeHead(nextStatus, nextHeaders) {
    status = nextStatus
    Object.assign(headers, nextHeaders ?? {})
    return response
  },
  end(chunk) {
    if (chunk !== undefined && chunk !== null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  },
}
await registered[0].handler(request, response)
const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
log(status === 200 && body.ok === true, 'GET /api/dsh-pomodoro answers a JSON state document', `HTTP ${status}`)
log(
  body.value?.settings?.focusMinutes === 25 && Array.isArray(body.value?.records),
  'the served state carries default settings and a record list',
)

// --- the framework owns disposal --------------------------------------------
log(registered.length === 1, 'route is still live before unload')
await app.stop?.()
await fiber.dispose?.()
log(disposed.length === 1, 'the framework disposed the route on unload, via ctx.effect', `${disposed.length} route(s) released`)

console.log('')
if (failures === 0) {
  console.log('OK: the plugin mounts, serves and unloads correctly under the real Cordis framework.')
  process.exit(0)
}
console.error(`${failures} check(s) failed.`)
process.exit(1)
