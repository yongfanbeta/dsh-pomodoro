/**
 * Tests for the JSON store and the host-side request handling: atomic writes,
 * corrupt-file quarantine, serialized updates, and the export/settings routes.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { JsonStore, stateFileIn, MAX_RECORDS } from '../lib/core/store.js'
import { normalizeState } from '../lib/core/state.js'

/** A temp directory removed when the test finishes. */
async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pomodoro-test-'))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('stateFileIn places the document under storages/pomodoro', () => {
  const path = stateFileIn('C:\\home\\.dsh')
  assert.ok(path.endsWith(join('storages', 'pomodoro', 'state.json')))
})

test('JsonStore starts from defaults when the file is missing', async () => {
  await withTempDir(async (dir) => {
    const store = new JsonStore(join(dir, 'nested', 'state.json'), normalizeState)
    const state = await store.load()
    assert.deepEqual(state.records, [])
    assert.equal(state.settings.focusMinutes, 25)
  })
})

test('JsonStore persists updates and reloads them', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'state.json')
    const store = new JsonStore(file, normalizeState)
    const record = {
      id: 'r1',
      project: '番茄',
      phase: 'focus',
      status: 'completed',
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_001_500,
      plannedMs: 1_500_000,
      focusedMs: 1_500_000,
    }
    await store.update((current) => ({ ...current, records: [record] }))

    const raw = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(raw.records.length, 1)
    assert.equal(raw.version, 1)
    assert.equal(raw.records[0].project, '番茄')

    const reopened = new JsonStore(file, normalizeState)
    assert.equal((await reopened.load()).records.length, 1)
  })
})

test('JsonStore serializes concurrent updates without losing a record', async () => {
  await withTempDir(async (dir) => {
    const store = new JsonStore(join(dir, 'state.json'), normalizeState)
    const base = 1_700_000_000_000
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        store.update((current) => ({
          ...current,
          records: [
            ...current.records,
            {
              id: `r${index}`,
              project: 'p',
              phase: 'focus',
              status: 'completed',
              startedAt: base + index,
              endedAt: base + index + 1,
              plannedMs: 1,
              focusedMs: 1,
            },
          ],
        })),
      ),
    )
    await store.drain()
    const persisted = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    assert.equal(persisted.records.length, 25)
  })
})

test('JsonStore quarantines a corrupt document instead of deleting it', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'state.json')
    await writeFile(file, '{ this is not json', 'utf8')
    const store = new JsonStore(file, normalizeState)
    const state = await store.load()
    assert.deepEqual(state.records, [])

    const files = await readdir(dir)
    const backup = files.find((name) => name.includes('.corrupt-'))
    assert.ok(backup, `expected a quarantine file, saw ${files.join(', ')}`)
    assert.equal(await readFile(join(dir, backup), 'utf8'), '{ this is not json')
  })
})

test('JsonStore caps the log at MAX_RECORDS', async () => {
  await withTempDir(async (dir) => {
    const store = new JsonStore(join(dir, 'state.json'), (raw) => normalizeState(raw, { maxRecords: 3 }))
    await store.update((current) => {
      const records = Array.from({ length: 10 }, (_, index) => ({
        id: `r${index}`,
        project: 'p',
        phase: 'focus',
        status: 'completed',
        startedAt: 1_700_000_000_000 + index,
        endedAt: 1_700_000_000_000 + index + 1,
        plannedMs: 1,
        focusedMs: 1,
      }))
      return { ...current, records }
    })
    const state = await store.snapshot()
    assert.equal(state.records.length, 3)
    // The newest survive.
    assert.equal(state.records[2].id, 'r9')
  })
})

test('MAX_RECORDS is a bounded positive number', () => {
  assert.ok(Number.isInteger(MAX_RECORDS) && MAX_RECORDS > 0)
})
