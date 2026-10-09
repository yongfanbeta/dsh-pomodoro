/**
 * Pre-restart load check.
 *
 * Re-derives the exact conditions the DSH host applies when it mounts a
 * dual-face plugin, against the *installed* copy in a profile. It exists
 * because the plugin cannot be loaded by restarting DSH from inside the
 * session it would kill; this runs the same checks instead.
 *
 * Usage:
 *   node scripts/verify-install.mjs [profileName]
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PLUGIN = 'dsh-pomodoro'
const results = []
let failed = 0

/** Record one check outcome. */
function check(label, ok, detail = '') {
  results.push({ label, ok, detail })
  if (!ok) failed += 1
}

/** Run one throwing probe and report its message on failure. */
async function attempt(label, run) {
  try {
    const detail = await run()
    check(label, true, typeof detail === 'string' ? detail : '')
  } catch (error) {
    check(label, false, error?.message ?? String(error))
  }
}

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profilesRoot = join(dshHome, 'profiles')

// --- resolve the profile ----------------------------------------------------
// The RUNNING profile wins (`DSH_PROFILE`), because that is the one whose
// bundles the user actually sees. A bare guess would happily validate an
// install sitting in a profile DSH is not using.
let profileName = process.argv[2] ?? process.env.DSH_PROFILE
if (profileName === undefined || profileName === '') {
  const entries = await readdir(profilesRoot, { withFileTypes: true })
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      await stat(join(profilesRoot, entry.name, 'package.json'))
      candidates.push(entry.name)
    } catch {
      /* not a profile */
    }
  }
  if (candidates.length === 0) {
    console.error(`no profile found under ${profilesRoot}`)
    process.exit(2)
  }
  profileName = candidates.includes('desktop') ? 'desktop' : candidates.includes('web') ? 'web' : candidates[0]
}

const profileDir = join(profilesRoot, profileName)
const pkgDir = join(profileDir, 'node_modules', PLUGIN)
console.log(`profile : ${profileName}`)
console.log(`plugin  : ${pkgDir}\n`)

// --- 1. registered in the bundle list ---------------------------------------
let manifest = null
await attempt('profile package.json is readable JSON', async () => {
  manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  return ''
})
check(
  `"${PLUGIN}" is in dsh.profile.bundles`,
  Array.isArray(manifest?.dsh?.profile?.bundles) && manifest.dsh.profile.bundles.includes(PLUGIN),
  JSON.stringify(manifest?.dsh?.profile?.bundles ?? null),
)

// --- 2. the installed package itself ----------------------------------------
let pkg = null
await attempt('installed package.json is valid JSON', async () => {
  pkg = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'))
  return `version ${pkg.version}`
})
check('package name matches the bundle row', pkg?.name === PLUGIN, String(pkg?.name))

// --- 3. host half -----------------------------------------------------------
const hostRel = typeof pkg?.exports?.['.'] === 'string' ? pkg.exports['.'] : pkg?.main
check('host half declares an entry', typeof hostRel === 'string', String(hostRel))
const hostPath = hostRel === undefined ? undefined : join(pkgDir, hostRel)
await attempt('host half file exists', async () => {
  const info = await stat(hostPath)
  return `${info.size} bytes`
})
await attempt('host half imports and exports the loader contract', async () => {
  const mod = await import(pathToFileURL(hostPath).href)
  if (mod.name !== PLUGIN) throw new Error(`exported name is "${mod.name}", expected "${PLUGIN}"`)
  if (typeof mod.apply !== 'function') throw new Error('no exported apply()')
  if (!Array.isArray(mod.inject)) throw new Error('no exported inject array')
  return `name="${mod.name}" inject=[${mod.inject.join(', ')}]`
})

// --- 4. client half, exactly as dsh-client-modules resolves it --------------
const decl = pkg?.dsh?.client
check('dsh.client.platform is "web"', decl?.platform === 'web', String(decl?.platform))
check('dsh.client.inject is a string array', Array.isArray(decl?.inject), JSON.stringify(decl?.inject ?? null))

const clientField = pkg?.exports?.['./client']
const clientRel =
  typeof clientField === 'string'
    ? clientField
    : typeof clientField?.default === 'string'
      ? clientField.default
      : undefined
check('exports["./client"] resolves to a path', typeof clientRel === 'string', String(clientRel))

const clientPath = clientRel === undefined ? undefined : join(pkgDir, clientRel)
let clientSource = ''
await attempt('client bundle file exists and is non-empty', async () => {
  const info = await stat(clientPath)
  if (info.size === 0) throw new Error('bundle is empty')
  clientSource = await readFile(clientPath, 'utf8')
  return `${info.size} bytes`
})

check(
  'client bundle registers itself through __ModuleLoader__.load',
  clientSource.includes('__ModuleLoader__.load('),
)
check(
  'client bundle registers under the package name',
  clientSource.includes(`id: '${PLUGIN}'`) || clientSource.includes(`id: "${PLUGIN}"`),
)
check(
  'client bundle is a plain script (no ESM import/export syntax)',
  !/^\s*(import|export)\s/m.test(clientSource),
)

// Bundle purity: every require() must be a platform seed or a declared inject.
const seedWords = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'])
const requires = [...clientSource.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
const undeclared = [...new Set(requires)].filter(
  (spec) => !seedWords.has(spec) && !(decl?.inject ?? []).some((injected) => spec === injected || spec.startsWith(`${injected}/`)),
)
check(
  'every client require() is a seed word or a declared inject',
  undeclared.length === 0,
  requires.length === 0 ? 'no requires' : `requires=[${[...new Set(requires)].join(', ')}]`,
)
check(
  'client bundle declares the three slot injections',
  ['sidebar.panellist', 'main', 'conversation.input.dock'].every((slot) => clientSource.includes(slot)),
)

// --- 5. the bundle patch row ------------------------------------------------
let patchText = ''
await attempt('cordis.patch.yml exists', async () => {
  patchText = await readFile(join(pkgDir, 'cordis.patch.yml'), 'utf8')
  return ''
})
check('patch inserts a row named after the package', new RegExp(`name:\\s*['"]?${PLUGIN}['"]?`).test(patchText))
check(
  'dsh.bundle.patch points at that file',
  pkg?.dsh?.bundle?.patch === './cordis.patch.yml',
  String(pkg?.dsh?.bundle?.patch),
)

// --- 6. the installed copy matches the source checkout -----------------------
// A stale install is the one failure the other checks cannot see: the files
// are all present and structurally valid, they are just an older revision.
const sourceDirs = await (async () => {
  // scripts/ lives one level below the package root.
  const { fileURLToPath } = await import('node:url')
  const root = fileURLToPath(new URL('..', import.meta.url))
  return { root, lib: join(root, 'lib') }
})()

/** Recursively collect files under `dir`, relative to it. */
async function walk(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true })
  const out = []
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) out.push(...(await walk(join(dir, entry.name), rel)))
    else out.push(rel)
  }
  return out
}

await attempt('installed lib/ matches the source checkout byte for byte', async () => {
  const sourceFiles = (await walk(sourceDirs.lib)).sort()
  const installedFiles = (await walk(join(pkgDir, 'lib'))).sort()
  if (sourceFiles.join(',') !== installedFiles.join(',')) {
    throw new Error(`file lists differ\n  source:    ${sourceFiles.join(', ')}\n  installed: ${installedFiles.join(', ')}`)
  }
  const stale = []
  for (const rel of sourceFiles) {
    const [a, b] = await Promise.all([
      readFile(join(sourceDirs.lib, rel)),
      readFile(join(pkgDir, 'lib', rel)),
    ])
    if (!a.equals(b)) stale.push(rel)
  }
  if (stale.length > 0) {
    throw new Error(`stale files: ${stale.join(', ')} — re-run scripts/install.ps1`)
  }
  return `${sourceFiles.length} file(s) identical`
})

// --- report -----------------------------------------------------------------
const width = Math.max(...results.map((entry) => entry.label.length))
for (const entry of results) {
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.label.padEnd(width)}  ${entry.detail}`)
}
console.log(`\n${results.length - failed}/${results.length} checks passed`)
if (failed > 0) {
  console.error(`\n${failed} check(s) failed — the plugin would not load correctly.`)
  process.exit(1)
}
console.log(`\nOK: ${PLUGIN} is installed correctly in the "${profileName}" profile.`)
console.log('Restart DSH to activate it; the sidebar will then show the pomodoro icon.')
