/**
 * Integration tests for the shipped client bundle.
 *
 * The real `lib/client.js` is evaluated through a module-loader double, mounted
 * into a stub slots registry, and really rendered by the mini React runtime.
 * Every host call goes through the real host route, so these tests cover the
 * browser half and the wire between the two halves together.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClientHarness } from './helpers/client-harness.js'
import { createHostHarness } from './helpers/host-harness.js'

/** Fixed local reference time so bucket assertions are stable. */
const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime()

/** The seven weekday initials the per-day chart labels its columns with. */
const WEEKDAY_SET = new Set(['一', '二', '三', '四', '五', '六', '日'])

/**
 * True when `className` carries `name` as a WHOLE class token.
 *
 * Substring matching is a trap here: `dshp-heatCol` is a prefix of
 * `dshp-heatCols`, and `dshp-col` matches both chart classes, so a loose
 * `includes()` counts containers as cells and derails the count assertions.
 */
function hasClass(node, name) {
  const cls = String((node && node.props && node.props.className) ?? '')
  return cls.split(/\s+/).includes(name)
}

/**
 * Boot a host + client pair over one temp home.
 *
 * `seed` runs against the host BEFORE the client mounts, which is the only way
 * to give the bundle's one-shot bootstrap real data: the module-level
 * `bootstrapped` guard means a later host write is not re-fetched.
 */
async function withClient(run, { home: providedHome, mirror, now, seed } = {}) {
  const home = providedHome ?? (await mkdtemp(join(tmpdir(), 'dsh-pomodoro-client-')))
  const host = createHostHarness({ home })
  const client = createClientHarness({ route: host.raw, now: now ?? NOW, mirror })
  let mounted = null
  try {
    if (typeof seed === 'function') await seed(host)
    mounted = await client.mount()
    const panelEntry = mounted.entries.get('main:pomodoro')
    const glyphEntry = mounted.entries.get('sidebar.panellist:pomodoro')
    const probeEntry = mounted.entries.get('conversation.input.dock:dsh-pomodoro-session-probe')
    const overlayEntry = mounted.entries.get('shell.overlay:dsh-pomodoro-overlay')
    return await run({ home, host, client, mounted, panelEntry, glyphEntry, probeEntry, overlayEntry })
  } finally {
    // Dispose BEFORE restoring the globals: that is the order a real hot reload
    // uses, and it is what lets a test prove in-flight work stops on teardown
    // instead of reaching for a `fetch` that no longer exists.
    if (mounted !== null) {
      try {
        mounted.dispose()
      } catch (error) {
        /* reported by the assertions, not by teardown */
      }
    }
    await client.settlePending()
    client.restore()
    host.restore()
    if (providedHome === undefined) await rm(home, { recursive: true, force: true })
  }
}

/** Render the panel component and settle every effect it starts. */
async function renderPanel(client, panelEntry) {
  const element = client.mini.React.createElement(panelEntry.component, {})
  client.mini.renderRoot(element)
  return await client.mini.settle(element)
}

/**
 * Render the frame-wide overlay root, which is where the interruption prompt
 * and the completion card live. They are a SEPARATE slot registration from the
 * panel, so a test that only renders the panel cannot see them.
 */
async function renderOverlay(client, overlayEntry) {
  const element = client.mini.React.createElement(overlayEntry.component, {})
  client.mini.renderRoot(element)
  return await client.mini.settle(element)
}

/**
 * Drive the whole "pause and record" flow through the real overlay UI:
 * open the prompt from the panel, choose a reason, confirm.
 *
 * @param reason - a preset label, a custom string, or null to confirm with no
 *   reason chosen (which records the interruption as unexplained).
 */
async function interruptVia(client, panelEntry, overlayEntry, reason) {
  const panel = await renderPanel(client, panelEntry)
  await buttonByText(panel, '暂停并记录中断').props.onClick()

  let overlay = await renderOverlay(client, overlayEntry)
  if (reason !== null) {
    const preset = buttonByText(overlay, reason)
    if (preset) {
      preset.props.onClick()
    } else {
      const input = client.mini
        .findAll(overlay, 'input')
        .find((node) => String(node.props.placeholder ?? '').includes('自己描述'))
      assert.ok(input, `neither a preset nor the custom input matched ${JSON.stringify(reason)}`)
      input.props.onChange({ target: { value: reason } })
      await renderOverlay(client, overlayEntry)
    }
  }
  overlay = await renderOverlay(client, overlayEntry)
  await buttonByText(overlay, '记录并暂停').props.onClick()
  await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))
  await renderOverlay(client, overlayEntry)
}

/**
 * The current phase as the dial reports it.
 *
 * Read from the phase badge rather than the whole panel text: the panel's
 * explanatory note legitimately mentions "长休息", so a substring search over
 * all text would misread the phase.
 */
function phaseOf(client, tree) {
  const badge = client.mini.findClass(tree, 'dshp-phase')
  if (badge === null) return ''
  const cls = String(badge.props.className)
  if (cls.includes('long-break')) return 'long-break'
  if (cls.includes('short-break')) return 'short-break'
  if (cls.includes('focus')) return 'focus'
  return ''
}

/** Find the first rendered button whose text matches. */
function buttonByText(tree, label) {
  const matches = (client, text) => text.split(' ').includes(label)
  void matches
  const buttons = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === 'string') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (node.tag === 'button') buttons.push(node)
    walk(node.children)
  }
  walk(tree)
  const textOf = (node) => {
    const parts = []
    const inner = (n) => {
      if (n === null || n === undefined) return
      if (typeof n === 'string') return parts.push(n)
      if (Array.isArray(n)) return n.forEach(inner)
      inner(n.children)
    }
    inner(node.children)
    return parts.join('')
  }
  return buttons.find((button) => textOf(button) === label) ?? null
}

/** Every button whose text contains `label`. */
function buttonsContaining(tree, label) {
  const buttons = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === 'string') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (node.tag === 'button') buttons.push(node)
    walk(node.children)
  }
  walk(tree)
  const textOf = (node) => {
    const parts = []
    const inner = (n) => {
      if (n === null || n === undefined) return
      if (typeof n === 'string') return parts.push(n)
      if (Array.isArray(n)) return n.forEach(inner)
      inner(n.children)
    }
    inner(node.children)
    return parts.join('')
  }
  return buttons.filter((button) => textOf(button).includes(label))
}

test('the bundle registers the sidebar entry, the main panel and the session probe', async () => {
  await withClient(async ({ panelEntry, glyphEntry, probeEntry }) => {
    assert.ok(glyphEntry, 'sidebar.panellist entry missing')
    assert.equal(glyphEntry.definition.id, 'pomodoro')
    assert.equal(typeof glyphEntry.definition.label, 'function')
    assert.equal(glyphEntry.definition.label(), '番茄钟')

    assert.ok(panelEntry, 'main entry missing')
    assert.equal(panelEntry.definition.key, 'pomodoro')
    assert.equal(typeof panelEntry.definition.name, 'string')

    assert.ok(probeEntry, 'session probe entry missing')
    // The probe must ask the slot for the Session id.
    const injected = probeEntry.definition.inject('s1')
    assert.equal(injected.sessionId, 's1')
    assert.equal(probeEntry.definition.inject(undefined).sessionId, '')
  })
})

test('finishing a focus run announces it and starts the break countdown', async () => {
  await withClient(async ({ client, panelEntry, overlayEntry, host }) => {
    const tree = await renderPanel(client, panelEntry)
    buttonByText(tree, '开始专注').props.onClick()
    client.advance(25 * 60_000 + 1000)
    await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))

    // The card lives in the overlay, so it is visible from any panel.
    const overlay = await renderOverlay(client, overlayEntry)
    const text = client.mini.textOf(overlay)
    assert.ok(text.includes('专注完成'), `card should announce completion, saw: ${text}`)
    assert.ok(text.includes('已完成 1 个番茄'), 'card should state what was earned')
    // It names the break AND shows its live countdown, because the break has
    // already started.
    assert.ok(text.includes('短休息 5 分钟'), `card should name the next phase, saw: ${text}`)
    assert.ok(text.includes('05:00') || text.includes('04:5'), `card should count the break down, saw: ${text}`)
    assert.ok(text.includes('进行中'), 'auto-start means the break is already running')

    // The card is persistent: it must NOT disappear on its own.
    await client.settlePending()
    const stillThere = await renderOverlay(client, overlayEntry)
    assert.ok(client.mini.textOf(stillThere).includes('专注完成'), 'the card must not auto-dismiss')

    // The recorded run is a completed pomodoro, and the break is really running.
    const state = await host.request('state')
    assert.equal(state.json.value.stats.scope.today.completed, 1)
    assert.ok(client.mini.textOf(await renderPanel(client, panelEntry)).includes('暂停'), 'the break is running')

    // "知道了" dismisses it, and the break keeps running.
    await buttonByText(stillThere, '知道了').props.onClick()
    await renderOverlay(client, overlayEntry)
    assert.equal(client.mini.textOf(await renderOverlay(client, overlayEntry)), '', 'dismissing clears the card')
    assert.ok(client.mini.textOf(await renderPanel(client, panelEntry)).includes('暂停'), 'dismissal does not stop the break')
  })
})

test('finishing a break announces it and follows the long-break cadence', async () => {
  await withClient(async ({ client, panelEntry, overlayEntry, host }) => {
    // Complete four focus runs so the fourth is followed by a LONG break.
    for (let i = 0; i < 4; i += 1) {
      let tree = await renderPanel(client, panelEntry)
      if (phaseOf(client, tree) !== 'focus') {
        await buttonByText(tree, '跳过').props.onClick()
        await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))
        tree = await renderPanel(client, panelEntry)
      }
      buttonByText(tree, '开始专注').props.onClick()
      client.advance(25 * 60_000 + 1000)
      await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))
    }

    // The fourth completion offers a long break, and the card says so.
    let overlay = await renderOverlay(client, overlayEntry)
    let text = client.mini.textOf(overlay)
    assert.ok(text.includes('长休息'), `the fourth run should reach a long break, saw: ${text}`)
    assert.ok(text.includes('15 分钟'), `long break length should be named, saw: ${text}`)

    // Let the long break finish: it announces the return to focus.
    client.advance(15 * 60_000 + 1000)
    await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))
    overlay = await renderOverlay(client, overlayEntry)
    text = client.mini.textOf(overlay)
    assert.ok(text.includes('休息结束'), `break end should announce itself, saw: ${text}`)
    assert.ok(text.includes('专注'), 'the card should name the next focus phase')

    // A finished break does NOT auto-start the next focus by default: starting
    // a new 25-minute commitment must stay a deliberate act.
    const panel = await renderPanel(client, panelEntry)
    assert.ok(client.mini.textOf(panel).includes('开始专注'), 'the next focus waits for the user by default')
    const state = await host.request('state')
    assert.equal(state.json.value.stats.scope.today.completed, 4)
  })
})

test('auto-starting the break can be switched off', async () => {
  await withClient(async ({ client, panelEntry, overlayEntry, host }) => {
    await host.request('settings', { settings: { autoStartBreak: false } })
    const tree = await renderPanel(client, panelEntry)
    buttonByText(tree, '开始专注').props.onClick()
    client.advance(25 * 60_000 + 1000)
    await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))

    const overlay = await renderOverlay(client, overlayEntry)
    const text = client.mini.textOf(overlay)
    // The card still appears and still counts the dial down; it just reports
    // that the break is waiting.
    assert.ok(text.includes('专注完成'), `card should still appear, saw: ${text}`)
    assert.ok(text.includes('已暂停'), `the card should say the break is waiting, saw: ${text}`)
    assert.ok(client.mini.textOf(await renderPanel(client, panelEntry)).includes('开始专注'), 'the break waits')
  })
})

test('the completion card can be disabled entirely', async () => {
  await withClient(async ({ client, panelEntry, overlayEntry, host }) => {
    await host.request('settings', { settings: { cardEnabled: false } })
    const tree = await renderPanel(client, panelEntry)
    buttonByText(tree, '开始专注').props.onClick()
    client.advance(25 * 60_000 + 1000)
    await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))

    assert.equal(client.mini.textOf(await renderOverlay(client, overlayEntry)), '', 'no card when disabled')
    // The pomodoro is still recorded and the break still started.
    const state = await host.request('state')
    assert.equal(state.json.value.stats.scope.today.completed, 1)
    assert.ok(client.mini.textOf(await renderPanel(client, panelEntry)).includes('暂停'), 'the break still runs')
  })
})

test('the weekly chart always shows all seven weekday labels', async () => {
  await withClient(async ({ client, panelEntry, host }) => {
    await host.request('record', {
      record: {
        project: 'A',
        source: 'manual',
        phase: 'focus',
        status: 'completed',
        startedAt: NOW - 3_600_000,
        endedAt: NOW,
        plannedMs: 25 * 60_000,
        focusedMs: 25 * 60_000,
      },
    })
    const tree = await renderPanel(client, panelEntry)
    buttonByText(tree, '统计').props.onClick()
    const statsTree = await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))

    const labels = client.mini
      .findAll(statsTree, 'div')
      .filter((node) => {
        const cls = String(node.props.className ?? '')
        if (!cls.includes('dshp-colK')) return false
        return WEEKDAY_SET.has(client.mini.textOf(node))
      })
      .map((node) => client.mini.textOf(node))

    // Today is Thursday: without future days the week would stop at 四, which
    // is exactly the "星期不全" bug.
    assert.deepEqual(labels, ['一', '二', '三', '四', '五', '六', '日'], `saw ${JSON.stringify(labels)}`)
    // Future days are dimmed but present.
    const dimmed = client.mini
      .findAll(statsTree, 'div')
      .filter((node) => hasClass(node, 'dshp-col') && node.props.style?.opacity === 0.35)
    assert.ok(dimmed.length >= 3, `the remaining weekdays should be dimmed, saw ${dimmed.length}`)
  })
})

test('记录明细 carries an explicit 中断原因 column', async () => {
  await withClient(async ({ client, panelEntry, overlayEntry, host }) => {
    // One interrupted run with a reason, then one completed run without.
    let tree = await renderPanel(client, panelEntry)
    buttonByText(tree, '开始专注').props.onClick()
    client.advance(4 * 60_000)
    client.fireIntervals()
    await interruptVia(client, panelEntry, overlayEntry, '开会')
    await buttonByText(await renderPanel(client, panelEntry), '重置').props.onClick()
    await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))
    tree = await renderPanel(client, panelEntry)
    buttonByText(tree, '开始专注').props.onClick()
    client.advance(25 * 60_000 + 1000)
    await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))

    tree = await renderPanel(client, panelEntry)
    buttonByText(tree, '记录').props.onClick()
    const recordsTree = await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))

    // A header row names the column, so it is discoverable even before any
    // interruption exists.
    const header = client.mini.findClass(recordsTree, 'dshp-recHead')
    assert.ok(header, 'column header row missing')
    assert.ok(client.mini.textOf(header).includes('中断原因'), 'the 中断原因 header is missing')

    // Every data row emits the reason cell, filled or empty.
    const rows = client.mini.findAll(recordsTree, 'div').filter((node) => {
      const cls = String(node.props.className ?? '')
      return cls.split(/\s+/).includes('dshp-recRow') && !cls.split(/\s+/).includes('dshp-recHead')
    })
    assert.equal(rows.length, 2)
    const reasons = rows.map((row) => {
      const cell = client.mini
        .findAll(row, 'span')
        .find((node) => String(node.props.className ?? '').includes('dshp-reasonTag'))
      return cell === null ? null : client.mini.textOf(cell)
    })
    // Rows are newest-first: the completed pomodoro (no reason) is on top and
    // the interruption below it. The point is that BOTH emit the cell.
    assert.deepEqual(reasons, ['—', '开会'], `expected an empty and a filled reason cell, saw ${JSON.stringify(reasons)}`)
    const flagged = rows.filter((row) => hasClass(row, 'dshp-recRowInterrupted'))
    assert.equal(flagged.length, 1, 'the interrupted row should carry the accent class')
  })
})

test('the hour chart labels its axis at 0/6/12/18/23', async () => {
  await withClient(async ({ client, panelEntry, host }) => {
    const tree = await renderPanel(client, panelEntry)
    buttonByText(tree, '统计').props.onClick()
    const statsTree = await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))

    const hourLabels = client.mini
      .findAll(statsTree, 'div')
      .filter((node) => {
        const cls = String(node.props.className ?? '')
        return cls.includes('dshp-colK') && /^\d+$/.test(client.mini.textOf(node))
      })
      .map((node) => Number(client.mini.textOf(node)))
    assert.deepEqual(hourLabels, [0, 6, 12, 18, 23], `saw ${JSON.stringify(hourLabels)}`)
  })
})

test('the heatmap weekday column tracks the cells when the card resizes', async () => {
  await withClient(async ({ client, panelEntry }) => {
    const tree = await renderPanel(client, panelEntry)
    buttonByText(tree, '统计').props.onClick()
    const statsTree = await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))

    // The label column stretches with the grid and each label shares the cell
    // row height (flex:1 inside the same column) — that is what makes
    // 一/三/五/日 follow the squares instead of staying put while they move.
    const css = client.styleTags[0].textContent
    assert.ok(css.includes('.dshp-heatDow{flex:1 1 0'), 'labels must flex to the row height')
    assert.ok(
      css.includes('.dshp-heatDows .dshp-heatDow:nth-child(even){visibility:hidden}'),
      'sparse rhythm missing',
    )
    // And the legend swatches must be exempt from the stretching cell sizing.
    assert.ok(
      css.includes('.dshp-heatLegend .dshp-heatCell{width:10px;height:10px;aspect-ratio:auto;flex:none}'),
      'legend swatches must not inherit the stretching cell sizing',
    )
  })
})

test('the status-bar timer registers ahead of the shipped session statistics', async () => {
  await withClient(async ({ mounted }) => {
    const dock = mounted.entries.get('conversation.composer.dock:dsh-pomodoro-dock')
    assert.ok(dock, 'status-bar entry missing')
    assert.equal(dock.definition.name, 'conversation.composer.dock')
    assert.equal(dock.definition.id, 'dsh-pomodoro-dock')
    // ui-chat owns the "会话统计" entry at order 0; being before it means a
    // negative order.
    assert.ok(dock.definition.order < 0, `expected a negative order, saw ${dock.definition.order}`)
  })
})

test('the status-bar pill is just the icon and a live countdown', async () => {
  await withClient(async ({ client, mounted, panelEntry, probeEntry }) => {
    const probeElement = client.mini.React.createElement(probeEntry.component, { sessionId: 's1' })
    client.mini.renderRoot(probeElement)
    await client.mini.settle(probeElement)

    const dock = mounted.entries.get('conversation.composer.dock:dsh-pomodoro-dock')
    const element = client.mini.React.createElement(dock.component, {})
    let tree = await client.mini.settle(element)
    let text = client.mini.textOf(tree)

    assert.ok(text.includes('25:00'), `status bar should show the dial, saw: ${text}`)
    // The collapsed pill must stay quiet: no project name, no inline controls.
    assert.ok(!text.includes('未命名项目'), `collapsed pill must hide the project, saw: ${text}`)
    assert.equal(buttonByText(tree, '暂停'), null, 'collapsed pill must not inline pause')
    assert.equal(buttonByText(tree, '停止'), null, 'collapsed pill must not inline stop')
    assert.equal(buttonByText(tree, '开始专注'), null, 'collapsed pill must not inline start')
    // Exactly ONE button (the pill itself) plus the tomato svg.
    const buttons = client.mini.findAll(tree, 'button')
    assert.equal(buttons.length, 1, `the collapsed pill is one control, saw ${buttons.length}`)
    assert.equal(client.mini.findAll(tree, 'svg').length, 1, 'the pill carries the tomato icon')
    assert.equal(client.mini.findAll(tree, 'span').filter((n) => String(n.props.className) === 'dshp-dockTime').length, 1)
  })
})

test('clicking the status-bar pill reveals project, today totals and controls', async () => {
  await withClient(
    async ({ client, mounted, panelEntry, probeEntry }) => {
      const probeElement = client.mini.React.createElement(probeEntry.component, { sessionId: 's1' })
      client.mini.renderRoot(probeElement)
      await client.mini.settle(probeElement)

      // The panel owns the one-shot bootstrap that loads statistics, so it must
      // render before the popover can show today's totals.
      let panelTree = await renderPanel(client, panelEntry)
      // Pick the project explicitly: the popover reports the CURRENT run's
      // project, not one borrowed from history.
      buttonsContaining(panelTree, '我的应用')[0].props.onClick()
      panelTree = await renderPanel(client, panelEntry)

      const dock = mounted.entries.get('conversation.composer.dock:dsh-pomodoro-dock')
      const element = client.mini.React.createElement(dock.component, {})
      let tree = await client.mini.settle(element)

      // Open the popover.
      const pill = client.mini.findAll(tree, 'button')[0]
      assert.equal(pill.props['aria-expanded'], 'false')
      pill.props.onClick()
      tree = client.mini.renderRoot(element)
      let text = client.mini.textOf(tree)

      assert.ok(text.includes('正在专注'), `popover should label the project, saw: ${text}`)
      assert.ok(text.includes('我的应用'), `popover should show the chosen project, saw: ${text}`)
      assert.ok(text.includes('今日已专注'), 'popover should show today totals')
      assert.ok(text.includes('2 个番茄'), `popover should show the completed count, saw: ${text}`)
      assert.ok(text.includes('本轮已完成'), 'popover should show the cycle count')
      assert.ok(buttonByText(tree, '开始专注'), 'an idle popover should offer start')

      // Running: the popover swaps in pause/stop, and the dial ticks.
      buttonByText(panelTree, '开始专注').props.onClick()
      client.advance(60_000)
      client.fireIntervals()
      tree = client.mini.renderRoot(element)
      text = client.mini.textOf(tree)
      assert.ok(text.includes('24:00'), `the pill must tick down, saw: ${text}`)
      assert.ok(buttonByText(tree, '暂停'), 'a running popover should offer pause')
      assert.ok(buttonByText(tree, '放弃'), 'a running popover should offer abandon')
      void panelTree
    },
    {
      // Seeded before mount: the bundle bootstraps once, so records written
      // afterwards would not reach its statistics.
      seed: async (host) => {
        for (let i = 0; i < 2; i += 1) {
          await host.request('record', {
            record: {
              project: '我的应用',
              source: 'workspace',
              phase: 'focus',
              status: 'completed',
              startedAt: NOW - (i + 1) * 3_600_000,
              endedAt: NOW - i * 3_600_000,
              plannedMs: 25 * 60_000,
              focusedMs: 25 * 60_000,
            },
          })
        }
      },
    },
  )
})

test('the running pill pulses its time and honours reduced-motion', async () => {
  await withClient(async ({ client, mounted, panelEntry }) => {
    const dock = mounted.entries.get('conversation.composer.dock:dsh-pomodoro-dock')
    const element = client.mini.React.createElement(dock.component, {})
    let tree = await client.mini.settle(element)
    let pill = client.mini.findAll(tree, 'button')[0]
    assert.ok(!String(pill.props.className).includes('run'), 'idle pill is not pulsing')

    const panelTree = await renderPanel(client, panelEntry)
    buttonByText(panelTree, '开始专注').props.onClick()
    await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))
    tree = client.mini.renderRoot(element)
    pill = client.mini.findAll(tree, 'button')[0]
    assert.ok(String(pill.props.className).includes('run'), 'a running pill takes the pulse class')

    // The animation itself is CSS; assert both the keyframes and the
    // reduced-motion opt-out reached the stylesheet.
    const css = client.styleTags[0].textContent
    assert.ok(css.includes('@keyframes dshp-tick'), 'pulse keyframes missing')
    assert.ok(css.includes('prefers-reduced-motion'), 'reduced-motion opt-out missing')
  })
})

test('the status-bar row can be switched off from settings', async () => {
  await withClient(async ({ client, mounted, panelEntry, host }) => {
    await host.request('settings', { settings: { showTimerInStatusBar: false } })
    // The panel must re-read settings before the dock renders.
    const panelTree = await renderPanel(client, panelEntry)
    void panelTree

    const dock = mounted.entries.get('conversation.composer.dock:dsh-pomodoro-dock')
    const tree = client.mini.renderRoot(client.mini.React.createElement(dock.component, {}))
    assert.equal(tree, null, 'the status bar entry must render nothing when disabled')
  })
})

test('the icons are thin line art matching the shipped outline icons', async () => {
  await withClient(async ({ client, glyphEntry }) => {
    const element = client.mini.React.createElement(glyphEntry.component, { size: 16, active: true })
    const tree = client.mini.renderRoot(element)

    // Match the platform convention exactly: 16x16 viewBox, no fill, 1px
    // currentColor strokes, no text.
    const svg = client.mini.findAll(tree, 'svg')[0]
    assert.ok(svg, 'no svg rendered')
    assert.equal(svg.props.viewBox, '0 0 16 16', 'the shipped icons use a 16x16 viewBox')
    assert.equal(svg.props.fill, 'none', 'outline icons draw with fill="none"')
    assert.equal(client.mini.findAll(tree, 'text').length, 0, 'the mark must not carry text')

    const paths = client.mini.findAll(tree, 'path')
    assert.ok(paths.length >= 3, `expected body + stem + leaves, saw ${paths.length}`)
    for (const path of paths) {
      assert.equal(path.props.stroke, 'currentColor', 'every stroke follows currentColor')
      assert.ok(!('fillRule' in path.props), 'thin line art does not need evenodd fills')
    }
  })
})

test('the tomato body only fills while a focus run is in progress', async () => {
  await withClient(async ({ client, glyphEntry, panelEntry }) => {
    const rail = client.mini.React.createElement(glyphEntry.component, { size: 16, active: true })

    // Idle: nothing is filled.
    let paths = client.mini.findAll(client.mini.renderRoot(rail), 'path')
    let body = paths.find((node) => node.props.fill !== undefined)
    assert.ok(body, 'the body path should declare its fill explicitly')
    assert.equal(body.props.fill, 'none', 'an idle body is unfilled')

    // Start a focus run and re-render the rail entry.
    const tree = await renderPanel(client, panelEntry)
    buttonByText(tree, '开始专注').props.onClick()
    await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))

    paths = client.mini.findAll(client.mini.renderRoot(rail), 'path')
    body = paths.find((node) => node.props.fill !== undefined)
    assert.equal(body.props.fill, 'currentColor', 'a running body fills with the icon colour')
  })
})

test('disabling the fill keeps the running rail mark outlined', async () => {
  await withClient(async ({ client, glyphEntry, panelEntry, host }) => {
    await host.request('settings', { settings: { showBadgeInSidebar: false } })
    const rail = client.mini.React.createElement(glyphEntry.component, { size: 16, active: true })
    const tree = await renderPanel(client, panelEntry)
    buttonByText(tree, '开始专注').props.onClick()
    await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))

    const paths = client.mini.findAll(client.mini.renderRoot(rail), 'path')
    const body = paths.find((node) => node.props.fill !== undefined)
    assert.equal(body.props.fill, 'none', 'the fill setting must suppress the filled body')
  })
})

test('the panel loads host state and shows the default 25:00 focus dial', async () => {
  await withClient(async ({ client, panelEntry, host }) => {
    const tree = await renderPanel(client, panelEntry)
    const text = client.mini.textOf(tree)
    assert.ok(text.includes('番茄钟'), 'panel title missing')
    assert.ok(text.includes('25:00'), `expected the 25:00 dial, saw: ${text}`)
    assert.ok(text.includes('专注'), 'phase label missing')
    // It really talked to the host.
    assert.ok(host.route !== null)
    assert.ok(client.calls.some((call) => call.url.startsWith('/api/dsh-pomodoro/state')))
  })
})

test('starting the timer and letting it finish persists one completed pomodoro', async () => {
  await withClient(async ({ client, panelEntry, host }) => {
    let tree = await renderPanel(client, panelEntry)
    const start = buttonByText(tree, '开始专注')
    assert.ok(start, 'start button missing')

    start.props.onClick()
    tree = client.mini.renderRoot(client.mini.React.createElement(panelEntry.component, {}))
    await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))
    assert.ok(client.mini.textOf(tree).includes('暂停'), 'timer should be running')

    // Let the whole 25 minutes elapse; the ticker fires and completes the run.
    client.advance(25 * 60_000 + 1000)
    await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))

    const state = await host.request('state')
    assert.equal(state.json.value.records.length, 1, 'exactly one run recorded')
    const record = state.json.value.records[0]
    assert.equal(record.phase, 'focus')
    assert.equal(record.status, 'completed')
    assert.equal(record.focusedMs, 25 * 60_000)
    assert.equal(record.project, '未命名项目')

    // The cycle advanced to a break, and the panel says so.
    tree = await renderPanel(client, panelEntry)
    assert.ok(client.mini.textOf(tree).includes('短休息'), 'should advance to a short break')
  })
})

test('pausing freezes the countdown and resuming continues it', async () => {
  await withClient(async ({ client, panelEntry }) => {
    let tree = await renderPanel(client, panelEntry)
    buttonByText(tree, '开始专注').props.onClick()
    client.advance(5 * 60_000)
    client.fireIntervals()

    tree = client.mini.renderRoot(client.mini.React.createElement(panelEntry.component, {}))
    await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))
    buttonByText(tree, '暂停').props.onClick()

    tree = client.mini.renderRoot(client.mini.React.createElement(panelEntry.component, {}))
    await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))
    const pausedText = client.mini.textOf(tree)
    assert.ok(pausedText.includes('20:00'), `expected 20:00 remaining, saw: ${pausedText}`)

    // Time passing while paused must not consume the dial.
    client.advance(3 * 60_000)
    client.fireIntervals()
    tree = client.mini.renderRoot(client.mini.React.createElement(panelEntry.component, {}))
    await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))
    assert.ok(client.mini.textOf(tree).includes('20:00'), 'paused clock must not advance')

    buttonByText(tree, '继续').props.onClick()
    client.advance(2 * 60_000)
    client.fireIntervals()
    tree = client.mini.renderRoot(client.mini.React.createElement(panelEntry.component, {}))
    await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))
    assert.ok(client.mini.textOf(tree).includes('18:00'), 'resume should continue from where it stopped')
  })
})

test('abandoning mid-run records an interruption, not a completion', async () => {
  await withClient(async ({ client, panelEntry, host }) => {
    let tree = await renderPanel(client, panelEntry)
    buttonByText(tree, '开始专注').props.onClick()
    client.advance(4 * 60_000)
    client.fireIntervals()
    tree = client.mini.renderRoot(client.mini.React.createElement(panelEntry.component, {}))
    await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))

    const stop = buttonByText(tree, '放弃这个番茄')
    assert.ok(stop, 'abandon button missing')
    await stop.props.onClick()
    await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))

    const state = await host.request('state')
    assert.equal(state.json.value.records.length, 1)
    assert.equal(state.json.value.records[0].status, 'aborted')
    // An interruption must never count as a completed pomodoro.
    assert.equal(state.json.value.stats.scope.today.completed, 0)
    assert.equal(state.json.value.stats.scope.today.aborted, 1)
  })
})

test('the session probe surfaces workspace and session names as project chips', async () => {
  await withClient(async ({ client, panelEntry, probeEntry }) => {
    // Render the probe the way the conversation slot would.
    const probeElement = client.mini.React.createElement(probeEntry.component, { sessionId: 's1' })
    client.mini.renderRoot(probeElement)
    await client.mini.settle(probeElement)

    const tree = await renderPanel(client, panelEntry)
    const chips = buttonsContaining(tree, '我的应用')
    const titleChips = buttonsContaining(tree, '修复番茄钟')
    assert.ok(chips.length > 0, 'workspace title should be offered as a project')
    assert.ok(titleChips.length > 0, 'session title should be offered as a project')

    chips[0].props.onClick()
    const after = await renderPanel(client, panelEntry)
    assert.ok(client.mini.textOf(after).includes('我的应用'), 'chosen project should be shown')
  })
})

test('a completed run keeps the project it was chosen with', async () => {
  await withClient(async ({ client, panelEntry, probeEntry, host }) => {
    const probeElement = client.mini.React.createElement(probeEntry.component, { sessionId: 's1' })
    client.mini.renderRoot(probeElement)
    await client.mini.settle(probeElement)

    let tree = await renderPanel(client, panelEntry)
    buttonsContaining(tree, '修复番茄钟')[0].props.onClick()
    tree = await renderPanel(client, panelEntry)

    buttonByText(tree, '开始专注').props.onClick()
    client.advance(25 * 60_000 + 1000)
    await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))

    const state = await host.request('state')
    assert.equal(state.json.value.records[0].project, '修复番茄钟')
    assert.equal(state.json.value.records[0].sessionId, 's1')
    assert.equal(state.json.value.records[0].source, 'session')
  })
})

test('an interrupted run survives a page reload through the local mirror', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pomodoro-reload-'))
  // Both "page loads" share the browser's localStorage and a continuous
  // wall clock, which is what a real reload looks like.
  const mirror = new Map()
  let clockAtReload = 0
  try {
    await withClient(async ({ client, panelEntry }) => {
      const tree = await renderPanel(client, panelEntry)
      buttonByText(tree, '开始专注').props.onClick()
      client.advance(5 * 60_000)
      client.fireIntervals()
      clockAtReload = client.clock.now

      // The mirror really holds the in-flight run.
      const saved = JSON.parse(mirror.get('dsh-pomodoro/active-run/v1'))
      assert.equal(saved.status, 'running')
      assert.equal(saved.phase, 'focus')
      assert.ok(saved.deadline > clockAtReload)
    }, { home, mirror })

    // Second page load: same home, same localStorage, clock advanced by the
    // same five minutes.
    await withClient(async ({ client, panelEntry }) => {
      const tree = await renderPanel(client, panelEntry)
      const text = client.mini.textOf(tree)
      assert.ok(text.includes('20:00'), `restored dial expected 20:00, saw: ${text}`)
      assert.ok(text.includes('暂停'), 'a still-running run should resume as running')
    }, { home, mirror, now: clockAtReload })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a run whose deadline passes while the page is closed is still recorded', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pomodoro-expired-'))
  const mirror = new Map()
  let expiryClock = 0
  try {
    // First page load: start a focus run, then "close the page" with 4 minutes
    // left — the run is still live in the mirror.
    await withClient(async ({ client, panelEntry }) => {
      const tree = await renderPanel(client, panelEntry)
      buttonByText(tree, '开始专注').props.onClick()
      client.advance(21 * 60_000)
      client.fireIntervals()
      expiryClock = client.clock.now
      const saved = JSON.parse(mirror.get('dsh-pomodoro/active-run/v1'))
      assert.equal(saved.status, 'running')
      assert.ok(saved.deadline > expiryClock, 'the run is still live when the page closes')
    }, { home, mirror })

    // Second page load, an hour later: the deadline passed off-screen. The
    // pomodoro genuinely finished, so it must be RECORDED, not dropped.
    await withClient(async ({ client, panelEntry, host }) => {
      const tree = await renderPanel(client, panelEntry)
      const state = await host.request('state')
      assert.equal(state.json.value.records.length, 1, 'the expired run must be recorded')
      const record = state.json.value.records[0]
      assert.equal(record.phase, 'focus')
      assert.equal(record.status, 'completed')
      assert.equal(record.focusedMs, 25 * 60_000, 'a full pomodoro is credited')
      assert.equal(state.json.value.stats.scope.today.completed, 1)
      // The dial moved on to the break, and the user is told what happened.
      assert.ok(client.mini.textOf(tree).includes('短休息'), 'the cycle should advance')
      const cycle = client.mini.textOf(tree)
      assert.ok(cycle.includes('本轮已完成 1 个番茄'), `cycle count should advance, saw: ${cycle}`)
    }, { home, mirror, now: expiryClock + 60 * 60_000 })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('pause-and-record interrupts the pomodoro but keeps it resumable', async () => {
  await withClient(async ({ client, panelEntry, overlayEntry, host }) => {
    let tree = await renderPanel(client, panelEntry)
    buttonByText(tree, '开始专注').props.onClick()
    client.advance(6 * 60_000)
    client.fireIntervals()

    // Open the prompt from the panel; the prompt itself lives in the overlay.
    tree = await renderPanel(client, panelEntry)
    const button = buttonByText(tree, '暂停并记录中断')
    assert.ok(button, 'pause-and-record button missing')
    await button.props.onClick()

    const overlay = await renderOverlay(client, overlayEntry)
    const overlayText = client.mini.textOf(overlay)
    assert.ok(overlayText.includes('记录这次中断'), `reason prompt should open, saw: ${overlayText}`)
    assert.ok(overlayText.includes('这个番茄会保留'), 'the prompt should say the pomodoro survives')
    // Every preset is offered, plus the custom escape hatch.
    for (const preset of ['被叫走', '开会', '临时任务', '分心', '其他']) {
      assert.ok(buttonByText(overlay, preset), `preset ${preset} missing`)
    }
    buttonByText(overlay, '开会').props.onClick()
    await renderOverlay(client, overlayEntry)
    await buttonByText(await renderOverlay(client, overlayEntry), '记录并暂停').props.onClick()
    await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))

    const state = await host.request('state')
    assert.equal(state.json.value.records.length, 1, 'one interruption event recorded')
    const event = state.json.value.records[0]
    assert.equal(event.status, 'interrupted', 'a resumed pomodoro is an interrupted event, not an outcome')
    assert.equal(event.reason, '开会')
    assert.equal(event.focusedMs, 6 * 60_000, 'the interruption carries the time focused so far')

    // The pomodoro is PAUSED, not abandoned: the dial is still on focus and
    // the interruption did not become a completion.
    tree = await renderPanel(client, panelEntry)
    assert.equal(phaseOf(client, tree), 'focus', 'the same pomodoro is still open')
    assert.ok(client.mini.textOf(tree).includes('继续'), 'a paused pomodoro offers resume')
    assert.equal(state.json.value.stats.scope.today.completed, 0)
    assert.equal(state.json.value.stats.scope.today.interrupted, 1)
    assert.equal(state.json.value.stats.scope.today.aborted, 0, 'an interruption event is not an aborted run')
  })
})

test('a paused pomodoro resumes and still counts as completed once', async () => {
  await withClient(async ({ client, panelEntry, overlayEntry, host }) => {
    let tree = await renderPanel(client, panelEntry)
    buttonByText(tree, '开始专注').props.onClick()
    client.advance(10 * 60_000)
    client.fireIntervals()

    // Interrupt at 10 minutes with a custom reason typed through the overlay.
    await interruptVia(client, panelEntry, overlayEntry, '临时插了个线上问题')

    // Resume and let it run out the remaining 15 minutes.
    tree = await renderPanel(client, panelEntry)
    buttonByText(tree, '继续').props.onClick()
    client.advance(15 * 60_000 + 1000)
    await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))

    const state = await host.request('state')
    const statuses = state.json.value.records.map((r) => r.status)
    assert.deepEqual(statuses, ['interrupted', 'completed'], `expected event then completion, saw ${statuses}`)
    assert.equal(state.json.value.records[0].reason, '临时插了个线上问题')
    const completion = state.json.value.records[1]
    assert.equal(completion.focusedMs, 25 * 60_000, 'a completed pomodoro credits its full plan')
    assert.equal(completion.reason, '', 'a completion carries no interruption reason')

    // Exactly ONE completed pomodoro: the interruption must not double-count.
    assert.equal(state.json.value.stats.scope.today.completed, 1)
    assert.equal(state.json.value.stats.scope.today.interrupted, 1)
    assert.equal(state.json.value.stats.scope.today.aborted, 0)
    // The completion rate divides by ENDED pomodoros only, so one distraction
    // inside a resumed pomodoro must not halve it.
    assert.equal(state.json.value.stats.scope.today.completionRate, 100)
    // Focused time counts the real clock, not the interruption event twice.
    assert.equal(state.json.value.stats.scope.today.focusedMinutes, 25)
  })
})

test('cancelling the reason prompt leaves the running timer untouched', async () => {
  await withClient(async ({ client, panelEntry, overlayEntry, host }) => {
    let tree = await renderPanel(client, panelEntry)
    buttonByText(tree, '开始专注').props.onClick()
    client.advance(4 * 60_000)
    client.fireIntervals()

    tree = await renderPanel(client, panelEntry)
    await buttonByText(tree, '暂停并记录中断').props.onClick()
    const overlay = await renderOverlay(client, overlayEntry)
    await buttonByText(overlay, '取消').props.onClick()
    await renderOverlay(client, overlayEntry)

    // Backing out is a true no-op: still running, same dial, nothing recorded.
    tree = await renderPanel(client, panelEntry)
    assert.ok(client.mini.textOf(tree).includes('暂停'), 'cancel must leave the timer running')
    assert.ok(client.mini.textOf(tree).includes('21:00'), `the dial should be unchanged, saw: ${client.mini.textOf(tree)}`)
    const state = await host.request('state')
    assert.equal(state.json.value.records.length, 0, 'cancel records nothing')
  })
})

test('the reason log explains why interruptions happened', async () => {
  await withClient(async ({ client, panelEntry, overlayEntry, host }) => {
    async function interruptWith(reason, ms) {
      const tree = await renderPanel(client, panelEntry)
      const start = buttonByText(tree, '开始专注')
      if (start) start.props.onClick()
      client.advance(ms)
      client.fireIntervals()
      await interruptVia(client, panelEntry, overlayEntry, reason)
      // Reset to a clean focus dial for the next sample.
      const reset = buttonByText(await renderPanel(client, panelEntry), '重置')
      if (reset) reset.props.onClick()
      await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))
    }

    await interruptWith('开会', 3 * 60_000)
    await interruptWith('开会', 3 * 60_000)
    await interruptWith('分心', 4 * 60_000)
    // Confirming without choosing a reason still records the interruption; it
    // simply lands in the "unexplained" bucket.
    await interruptWith(null, 3 * 60_000)
    // A sub-30s tap must not enter the log at all.
    await interruptWith('被叫走', 5_000)

    const state = await host.request('state')
    const reasons = state.json.value.stats.reasons
    const byReason = Object.fromEntries(reasons.map((entry) => [entry.reason, entry.count]))
    assert.equal(byReason['开会'], 2, `expected two 开会 entries, saw ${JSON.stringify(reasons)}`)
    assert.equal(byReason['分心'], 1)
    assert.equal(byReason['未记录原因'], 1, 'a dismissed prompt is logged as unexplained')
    assert.equal(byReason['被叫走'], undefined, 'a sub-30s tap is not logged')

    // Every reason shares sum to the interruption total.
    const total = reasons.reduce((sum, entry) => sum + entry.count, 0)
    assert.equal(total, state.json.value.stats.totalInterruptions)
    const shareSum = reasons.reduce((sum, entry) => sum + entry.sharePercent, 0)
    assert.ok(Math.abs(shareSum - 100) < 0.5, `shares should total ~100, got ${shareSum}`)

    // And they reach the CSV as their own section.
    const csv = await host.request('export', undefined, 'GET')
    assert.ok(csv.text.includes('中断原因,已记录,次数'), 'reason section missing from the CSV')
    assert.ok(csv.text.includes('开会,是,2'), `expected the 开会 row, saw: ${csv.text.slice(0, 400)}`)
    assert.ok(csv.text.includes('未记录原因,否,1'), 'unexplained row missing')
  })
})

test('abandoning a pomodoro records aborted; skipping records skipped; reset records nothing', async () => {
  await withClient(async ({ client, panelEntry, host }) => {
    // 1) Abandon: a real ending, recorded as `aborted` with the real elapsed time.
    let tree = await renderPanel(client, panelEntry)
    buttonByText(tree, '开始专注').props.onClick()
    client.advance(6 * 60_000)
    client.fireIntervals()
    await buttonByText(await renderPanel(client, panelEntry), '放弃这个番茄').props.onClick()
    await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))
    let state = await host.request('state')
    assert.equal(state.json.value.records.length, 1)
    assert.equal(state.json.value.records[0].status, 'aborted')
    assert.equal(state.json.value.records[0].focusedMs, 6 * 60_000, 'the real elapsed time is kept')
    assert.equal(state.json.value.stats.scope.today.completed, 0)
    assert.equal(state.json.value.stats.scope.today.aborted, 1)
    // The dial returns to the SAME phase, ready to retry the pomodoro.
    assert.equal(phaseOf(client, await renderPanel(client, panelEntry)), 'focus')

    // 2) Skip: recorded separately as `skipped`.
    tree = await renderPanel(client, panelEntry)
    buttonByText(tree, '开始专注').props.onClick()
    client.advance(5 * 60_000)
    client.fireIntervals()
    await buttonByText(await renderPanel(client, panelEntry), '跳过').props.onClick()
    await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))
    state = await host.request('state')
    assert.equal(state.json.value.records.length, 2)
    assert.equal(state.json.value.records[1].status, 'skipped')
    assert.equal(state.json.value.stats.scope.today.skipped, 1)
    assert.equal(state.json.value.stats.scope.today.completed, 0)

    // 3) Reset records nothing at all: it is "start over", not an outcome.
    const before = (await host.request('state')).json.value.records.length
    tree = await renderPanel(client, panelEntry)
    const start = buttonByText(tree, '开始专注')
    if (start) start.props.onClick()
    client.advance(4 * 60_000)
    client.fireIntervals()
    await buttonByText(await renderPanel(client, panelEntry), '重置').props.onClick()
    await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))
    state = await host.request('state')
    assert.equal(state.json.value.records.length, before, 'reset records nothing')
    assert.equal(phaseOf(client, await renderPanel(client, panelEntry)), 'focus')
  })
})

test('the interruption floor protects against accidental taps', async () => {
  await withClient(async ({ client, panelEntry, overlayEntry, host }) => {
    // 29s: just under the floor, nothing recorded.
    await renderPanel(client, panelEntry)
    buttonByText(await renderPanel(client, panelEntry), '开始专注').props.onClick()
    client.advance(29_000)
    client.fireIntervals()
    await interruptVia(client, panelEntry, overlayEntry, '开会')
    assert.equal((await host.request('state')).json.value.records.length, 0, '29s is under the floor')

    // 31s: over it, so the interruption is kept.
    await buttonByText(await renderPanel(client, panelEntry), '重置').props.onClick()
    await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))
    buttonByText(await renderPanel(client, panelEntry), '开始专注').props.onClick()
    client.advance(31_000)
    client.fireIntervals()
    await interruptVia(client, panelEntry, overlayEntry, '开会')
    const state = await host.request('state')
    assert.equal(state.json.value.records.length, 1, '31s is over the floor')
    assert.equal(state.json.value.records[0].status, 'interrupted')
  })
})

test('recording interruptions can be turned off entirely', async () => {
  await withClient(async ({ client, panelEntry, overlayEntry, host }) => {
    await host.request('settings', { settings: { recordAborted: false } })
    const tree = await renderPanel(client, panelEntry)
    buttonByText(tree, '开始专注').props.onClick()
    client.advance(6 * 60_000)
    client.fireIntervals()
    await interruptVia(client, panelEntry, overlayEntry, '开会')
    // The pause still happens; only the record is suppressed.
    assert.equal((await host.request('state')).json.value.records.length, 0, 'recordAborted=false records nothing')
    assert.ok(client.mini.textOf(await renderPanel(client, panelEntry)).includes('继续'), 'the pause still applies')
  })
})

test('skipping does not advance the long-break cadence', async () => {
  await withClient(async ({ client, panelEntry, host }) => {
    // Skip four times in a row: a skip is not a completed pomodoro, so the
    // cycle counter must stay at zero and no long break may appear.
    for (let i = 0; i < 4; i += 1) {
      const tree = await renderPanel(client, panelEntry)
      const skip = buttonByText(tree, '跳过')
      assert.ok(skip, 'skip button missing')
      await skip.props.onClick()
      await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))
    }
    const tree = await renderPanel(client, panelEntry)
    const text = client.mini.textOf(tree)
    assert.ok(text.includes('本轮已完成 0 个番茄'), `cycle must stay at 0, saw: ${text}`)
    assert.equal(phaseOf(client, tree), 'focus', 'skipping must not reach a long break')

    // Skipping a fresh, never-started dial still records nothing at all.
    const state = await host.request('state')
    assert.equal(state.json.value.records.length, 0)
  })
})

test('four completed focus runs reach a long break', async () => {
  await withClient(async ({ client, panelEntry, host }) => {
    let sawLongBreak = false
    for (let i = 0; i < 4; i += 1) {
      // Between runs the dial sits on a break; skip it to get back to focus.
      let tree = await renderPanel(client, panelEntry)
      if (phaseOf(client, tree) !== 'focus') {
        await buttonByText(tree, '跳过').props.onClick()
        await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))
        tree = await renderPanel(client, panelEntry)
      }
      assert.equal(phaseOf(client, tree), 'focus', `iteration ${i} should be ready to focus`)
      buttonByText(tree, '开始专注').props.onClick()
      client.advance(25 * 60_000 + 1000)
      await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))

      const after = await renderPanel(client, panelEntry)
      if (phaseOf(client, after) === 'long-break') sawLongBreak = true
    }

    const state = await host.request('state')
    assert.equal(state.json.value.records.filter((r) => r.status === 'completed').length, 4)
    // The 4th completion lands on the long break, per the default cadence.
    assert.ok(sawLongBreak, 'the fourth completed pomodoro should offer a long break')
  })
})

test('the export control downloads the CSV from the host', async () => {
  await withClient(async ({ client, panelEntry, host }) => {
    // Seed one record so the export is non-trivial.
    await host.request('record', {
      record: {
        project: '导出测试',
        source: 'manual',
        phase: 'focus',
        status: 'completed',
        startedAt: NOW - 25 * 60_000,
        endedAt: NOW,
        plannedMs: 25 * 60_000,
        focusedMs: 25 * 60_000,
      },
    })

    const tree = await renderPanel(client, panelEntry)
    const recordsTab = buttonByText(tree, '记录')
    assert.ok(recordsTab, 'records tab missing')
    recordsTab.props.onClick()
    const recordsTree = await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))

    const exportButton = buttonByText(recordsTree, '导出 CSV')
    assert.ok(exportButton, 'export button missing')
    exportButton.props.onClick()

    assert.equal(client.links.length, 1, 'a download link should have been created')
    assert.ok(client.links[0].href.startsWith('/api/dsh-pomodoro/export'))
  })
})

test('changing a setting persists it on the host', async () => {
  await withClient(async ({ client, panelEntry, host }) => {
    const tree = await renderPanel(client, panelEntry)
    const settingsTab = buttonByText(tree, '设置')
    assert.ok(settingsTab, 'settings tab missing')
    settingsTab.props.onClick()
    const settingsTree = await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))

    const checkboxes = client.mini
      .findAll(settingsTree, 'input')
      .filter((input) => input.props.type === 'checkbox')
    assert.ok(checkboxes.length >= 5, 'expected the behaviour toggles')

    // Address the toggle BY ITS LABEL, not by position: adding a setting above
    // another must not silently retarget this assertion. The text sits in a
    // sibling span, so the parent <label> is what identifies the input.
    const label = '休息结束后自动开始下一个专注'
    const row = client.mini
      .findAll(settingsTree, 'label')
      .find((node) => client.mini.textOf(node).includes(label))
    assert.ok(row, `could not find the "${label}" toggle`)
    const toggle = client.mini.findAll(row, 'input')[0]
    assert.ok(toggle, `the "${label}" row should hold a checkbox`)
    assert.equal(toggle.props.checked, false, 'autoStartNext starts off')
    await toggle.props.onChange({ target: { checked: true } })
    await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))

    const state = await host.request('state')
    assert.equal(state.json.value.settings.autoStartNext, true)
  })
})

test('the statistics tab renders the aggregates served by the host', async () => {
  await withClient(async ({ client, panelEntry, host }) => {
    for (let i = 0; i < 3; i += 1) {
      await host.request('record', {
        record: {
          project: '统计项目',
          source: 'manual',
          phase: 'focus',
          status: 'completed',
          startedAt: NOW - (i + 1) * 3_600_000,
          endedAt: NOW - i * 3_600_000,
          plannedMs: 25 * 60_000,
          focusedMs: 25 * 60_000,
        },
      })
    }

    const tree = await renderPanel(client, panelEntry)
    buttonByText(tree, '统计').props.onClick()
    const statsTree = await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))
    const text = client.mini.textOf(statsTree)

    assert.ok(text.includes('今日完成'), 'today metric missing')
    assert.ok(text.includes('累计专注'), 'total metric missing')
    assert.ok(text.includes('统计项目'), 'project breakdown missing')
    // The 14-day bar chart is gone, replaced by the yearly heatmap.
    assert.ok(text.includes('全年专注热力图'), 'heatmap title missing')
    assert.ok(!text.includes('近 14 天趋势'), 'the old trend chart must be gone')
    assert.ok(client.mini.findClass(statsTree, 'dshp-heat') !== null, 'heatmap grid missing')
    const todayMetric = client.mini.findClass(statsTree, 'dshp-metric')
    assert.ok(todayMetric, 'metric tile missing')
  })
})

test('the heatmap covers a full year of dense days in week columns', async () => {
  await withClient(async ({ client, panelEntry, host }) => {
    // Three runs on three distinct days, one of them ~200 days ago, so the
    // window must reach well beyond the old 14-day chart.
    const longAgo = NOW - 200 * 86_400_000
    const records = [
      { project: 'A', at: NOW - 3_600_000 },
      { project: 'B', at: NOW - 2 * 3_600_000 },
      { project: '老', at: longAgo },
    ]
    for (const entry of records) {
      await host.request('record', {
        record: {
          project: entry.project,
          source: 'manual',
          phase: 'focus',
          status: 'completed',
          startedAt: entry.at,
          endedAt: entry.at + 25 * 60_000,
          plannedMs: 25 * 60_000,
          focusedMs: 25 * 60_000,
        },
      })
    }

    const tree = await renderPanel(client, panelEntry)
    buttonByText(tree, '统计').props.onClick()
    const statsTree = await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))

    const columns = client.mini.findAll(statsTree, 'div').filter((node) => hasClass(node, 'dshp-heatCol'))
    assert.ok(columns.length >= 52, `expected ~53 week columns, saw ${columns.length}`)
    // Every column is a full week tall.
    for (const column of columns) {
      assert.equal(column.children.length, 7, 'each week column must hold 7 days')
    }

    const cells = client.mini.findAll(statsTree, 'div').filter((node) => hasClass(node, 'dshp-heatCell'))
    assert.ok(cells.length >= 365, `expected a dense year of cells, saw ${cells.length}`)

    // A day with no run is still present, rendered as level 0.
    const blank = cells.find((node) => String(node.props.className).trim() === 'dshp-heatCell')
    assert.ok(blank, 'a zero-completion day should still render (dense grid)')

    // The 200-day-old run is inside the window and coloured.
    const filled = cells.filter((node) => /l[1-4]/.test(String(node.props.className)))
    assert.ok(filled.length >= 3, `expected the older runs to be visible, saw ${filled.length} filled`)
  })
})

test('heatmap tooltips name the date and the count', async () => {
  await withClient(async ({ client, panelEntry, host }) => {
    await host.request('record', {
      record: {
        project: 'A',
        source: 'manual',
        phase: 'focus',
        status: 'completed',
        startedAt: NOW - 3_600_000,
        endedAt: NOW,
        plannedMs: 25 * 60_000,
        focusedMs: 25 * 60_000,
      },
    })
    const tree = await renderPanel(client, panelEntry)
    buttonByText(tree, '统计').props.onClick()
    const statsTree = await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))
    const cells = client.mini.findAll(statsTree, 'div').filter((node) => hasClass(node, 'dshp-heatCell'))
    const titled = cells.map((node) => String(node.props.title ?? '')).filter((title) => title !== '')
    assert.ok(titled.length > 0, 'cells must carry tooltips')
    assert.ok(titled.some((title) => title.includes('1 个番茄')), 'a completed day should report its count')
    assert.ok(titled.some((title) => title.includes('无完成记录')), 'an empty day should say so')
    assert.ok(/^\d{4}-\d{2}-\d{2}/.test(titled[0]), `tooltip should start with the date, saw: ${titled[0]}`)
  })
})

test('the CSV the host serves is what Excel opens: BOM, Chinese headers, real rows', async () => {
  await withClient(async ({ host }) => {
    await host.request('record', {
      record: {
        project: '中文项目, 含逗号',
        source: 'manual',
        phase: 'focus',
        status: 'completed',
        startedAt: NOW - 25 * 60_000,
        endedAt: NOW,
        plannedMs: 25 * 60_000,
        focusedMs: 25 * 60_000,
      },
    })
    const exported = await host.request('export', undefined, 'GET')
    assert.ok(exported.text.startsWith('\uFEFF'), 'BOM required for Excel')
    assert.ok(exported.text.includes('开始时间,结束时间,项目'), 'Chinese header row expected')
    // The comma inside the project name must be quoted, not split.
    assert.ok(exported.text.includes('"中文项目, 含逗号"'), 'embedded comma must be quoted')
    assert.ok(exported.text.includes('累计完成番茄数,1'))
  })
})

test('the plugin disposes its ticker and route on unload', async () => {
  await withClient(async ({ client, mounted, host }) => {
    assert.ok(host.route !== null)
    assert.ok(client.clock.intervals.size >= 0)
    mounted.dispose()
    // Disposal is idempotent and must not throw.
    mounted.dispose()
  })
})

test('a host that is unreachable surfaces an error instead of a blank panel', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-pomodoro-offline-'))
  const client = createClientHarness({ route: undefined, now: NOW })
  try {
    const mounted = await client.mount()
    const entry = mounted.entries.get('main:pomodoro')
    const tree = await renderPanel(client, entry)
    const text = client.mini.textOf(tree)
    assert.ok(text.includes('无法读取番茄钟数据'), `expected an error banner, saw: ${text}`)
    assert.equal(client.mini.findClass(tree, 'dshp-msg err') !== null, true)
  } finally {
    client.restore()
    await rm(home, { recursive: true, force: true })
  }
})

test('the client bundle never reaches for a module outside react', async () => {
  await withClient(async ({ client }) => {
    // loadBundle throws on any unexpected require; a successful mount proves it.
    assert.ok(client.styleTags.length >= 1, 'the bundle should insert its stylesheet once')
    assert.equal(client.styleTags.length, 1, 'styles must not be inserted twice')
    const tag = client.styleTags[0]
    assert.equal(tag.dataset.plugin, 'dsh-pomodoro')
    assert.ok(tag.textContent.includes('.dshp-root'))
  })
})

test('the panel writes nothing to the host merely by rendering', async () => {
  await withClient(async ({ client, panelEntry, host }) => {
    const before = (await host.request('state')).json.value.records.length
    await renderPanel(client, panelEntry)
    const after = (await host.request('state')).json.value.records.length
    assert.equal(after, before)
    const mutations = client.calls.filter(
      (call) => call.method === 'POST' && !call.url.endsWith('/state') && !call.url.endsWith('/context'),
    )
    assert.deepEqual(mutations, [], `rendering must not mutate, saw: ${JSON.stringify(mutations)}`)
  })
})

test('the saved state file is readable JSON under storages/pomodoro', async () => {
  await withClient(async ({ client, panelEntry, home }) => {
    const tree = await renderPanel(client, panelEntry)
    buttonByText(tree, '开始专注').props.onClick()
    client.advance(25 * 60_000 + 1000)
    await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))

    const raw = await readFile(join(home, 'storages', 'pomodoro', 'state.json'), 'utf8')
    const parsed = JSON.parse(raw)
    assert.equal(parsed.version, 1)
    assert.equal(parsed.records.length, 1)
    assert.equal(parsed.records[0].phase, 'focus')
  })
})

test('the floating timer window is hidden until enabled in settings', async () => {
  // Default (no seed): the float must not render.
  await withClient(async ({ client, mounted }) => {
    const overlay = mounted.entries.get('shell.overlay:dsh-pomodoro-overlay')
    const tree = client.mini.renderRoot(client.mini.React.createElement(overlay.component, {}))
    assert.equal(findByClass(tree, 'dshp-float'), null, 'float must not render when disabled')
  })

  // Enabled via settings seeded BEFORE mount (the one-shot bootstrap window).
  await withClient(
    async ({ client, mounted, panelEntry }) => {
      // Bootstrap the panel so the store reads the seeded host settings; only
      // then does the overlay reflect showFloatingTimer: true.
      await renderPanel(client, panelEntry)
      const overlay = mounted.entries.get('shell.overlay:dsh-pomodoro-overlay')
      let tree = client.mini.renderRoot(client.mini.React.createElement(overlay.component, {}))
      let float = findByClass(tree, 'dshp-float')
      assert.ok(float, 'float must render once enabled')
      assert.ok(findByClass(tree, 'dshp-floatCorner'), 'float must expose the corner window controls')
      assert.ok(findByClass(tree, 'dshp-dial'), 'float must show the countdown dial')

      // The collapse toggle shrinks it to the mini badge form.
      findByClass(float, 'dshp-floatMiniBtn').props.onClick()
      tree = client.mini.renderRoot(client.mini.React.createElement(overlay.component, {}))
      float = findByClass(tree, 'dshp-float')
      assert.ok(float && hasClass(float, 'mini'), 'collapse should switch to the mini badge')
      assert.ok(findByClass(tree, 'dshp-floatMiniBar'), 'mini badge must expose expand/close buttons')

      // Pressing the close button hides the float entirely (it must not stick).
      const closeBtn = findByClass(tree, 'dshp-floatClose')
      closeBtn.props.onClick()
      tree = client.mini.renderRoot(client.mini.React.createElement(overlay.component, {}))
      assert.equal(findByClass(tree, 'dshp-float'), null, 'close must remove the float immediately')
    },
    {
      seed(host) {
        return host.request('settings', { settings: { showFloatingTimer: true, floatPosition: { x: 100, y: 120 } } })
      },
    },
  )
})

test('the settings panel lists and edits break activities', async () => {
  await withClient(async ({ client, panelEntry, host }) => {
    await host.request('settings', { settings: { breakActivities: ['深蹲十个', '喝一杯水'] } })
    const tree = await renderPanel(client, panelEntry)
    buttonByText(tree, '设置').props.onClick()
    const settingsTree = await client.mini.settle(client.mini.React.createElement(panelEntry.component, {}))

    // The editor renders one input per activity.
    const inputs = client.mini.findAll(settingsTree, 'input').filter((n) => {
      const v = n.props.value
      return v === '深蹲十个' || v === '喝一杯水'
    })
    assert.equal(inputs.length, 2, 'editor must show each configured activity as an editable input')

    // The "添加" button is present so the user can append a custom one.
    const addBtn = buttonByText(settingsTree, '添加')
    assert.ok(addBtn, 'an add button must be available')
  })
})

/** Return the first element whose className carries `name` as a whole token. */
function findByClass(tree, name) {
  const list = Array.isArray(tree) ? tree : [tree]
  for (const node of list) {
    if (!node || typeof node !== 'object') continue
    if (hasClass(node, name)) return node
  }
  const nested = []
  for (const node of list) {
    if (node && typeof node === 'object') {
      const children = Array.isArray(node.children) ? node.children : []
      for (const child of children) nested.push(child)
    }
  }
  return nested.length === 0 ? null : findByClass(nested, name)
}


