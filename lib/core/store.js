/**
 * dsh-pomodoro core: durable local storage for the pomodoro log.
 *
 * One JSON document under the harness home, written atomically (temp file +
 * rename) and serialized through a promise chain so two concurrent record
 * writes can never interleave into a truncated file.
 *
 * Deliberately dependency-free: the host half imports this through plain
 * `node:` builtins, which keeps the plugin installable as a single tarball
 * with no postinstall step.
 */

import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Cap the log so an aggressive user cannot grow the file without bound. */
export const MAX_RECORDS = 20000

/** Single-line-safe JSON: never persist `undefined` members. */
function serialize(state) {
  return JSON.stringify(
    {
      version: state.version,
      settings: state.settings,
      records: state.records,
    },
    null,
    2,
  )
}

/**
 * A JSON-file store. Callers pass the pure `normalizeState` so the store stays
 * agnostic about schema evolution.
 */
export class JsonStore {
  #path
  #normalize
  #state = null
  #queue = Promise.resolve()
  #dirty = false

  /**
   * @param path - absolute path of the JSON document.
   * @param normalize - `(unknown) => state`; also applies defaults.
   */
  constructor(path, normalize) {
    this.#path = path
    this.#normalize = normalize
  }

  /** Absolute path of the backing file (reported to the UI for transparency). */
  get path() {
    return this.#path
  }

  /** Load once, then serve the cached document. Missing/corrupt files self-heal. */
  async load() {
    if (this.#state !== null) return this.#state
    let parsed = null
    try {
      parsed = JSON.parse(await readFile(this.#path, 'utf8'))
    } catch (error) {
      // A missing file is the normal first run. A corrupt file is quarantined
      // instead of silently discarded, so a user can still recover the log.
      if (error?.code !== 'ENOENT') await this.#quarantine(error)
    }
    this.#state = this.#normalize(parsed)
    return this.#state
  }

  /** Current in-memory snapshot (loads first when necessary). */
  async snapshot() {
    return await this.load()
  }

  /**
   * Mutate the document under the write lock and persist the result.
   *
   * @param mutate - receives the current state, returns the next state.
   * @returns the persisted state.
   */
  async update(mutate) {
    const run = this.#queue.then(async () => {
      const current = await this.load()
      const next = mutate(current) ?? current
      this.#state = this.#normalize(next)
      await this.#persist(this.#state)
      this.#dirty = false
      return this.#state
    })
    // Keep the chain alive after a failed write without swallowing the error
    // for the caller that awaits `run`.
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    )
    return await run
  }

  /** True while a change has been applied in memory but not yet written. */
  get pending() {
    return this.#dirty
  }

  /** Promise that settles when every queued write has finished. */
  async drain() {
    await this.#queue
  }

  /** Atomic write: temp file in the same directory, then rename over target. */
  async #persist(state) {
    const dir = dirname(this.#path)
    await mkdir(dir, { recursive: true })
    const temp = `${this.#path}.${process.pid}.${Date.now().toString(36)}.tmp`
    try {
      await writeFile(temp, serialize(state), 'utf8')
      await rename(temp, this.#path)
    } catch (error) {
      await unlink(temp).catch(() => undefined)
      this.#dirty = true
      throw error
    }
  }

  /** Move an unreadable document aside so the next write starts from defaults. */
  async #quarantine(cause) {
    const backup = `${this.#path}.corrupt-${Date.now().toString(36)}`
    await rename(this.#path, backup).catch(() => undefined)
    console.error(`[dsh-pomodoro] state file unreadable (${cause?.message ?? cause}); kept it at ${backup}`)
  }
}

/** Default document location inside a harness home. */
export function stateFileIn(home) {
  return join(home, 'storages', 'pomodoro', 'state.json')
}
