/**
 * A miniature React runtime.
 *
 * Purpose-built for this suite: it implements exactly the surface the
 * dsh-pomodoro client half uses, so the shipped bundle can be really mounted
 * and rendered without pulling a browser or a full reconciler into the test
 * run. It is not a general React implementation.
 */

/** Create a hook runtime plus a renderer over it. */
export function createMiniReact() {
  /** per-component-path hook slots, so state survives re-renders by position */
  const nodes = new Map()
  let currentPath = ''
  let dirty = false
  let rendering = false
  const pendingEffects = []

  function nodeAt(path) {
    let node = nodes.get(path)
    if (node === undefined) {
      node = { hooks: [], cursor: 0, cleanups: [] }
      nodes.set(path, node)
    }
    return node
  }

  function slot() {
    const node = nodeAt(currentPath)
    const index = node.cursor
    node.cursor += 1
    if (node.hooks.length <= index) node.hooks.push({})
    return { node, state: node.hooks[index], index }
  }

  /** Flag a needed re-render; the render loop in renderRoot/settle picks it up. */
  function markDirty() {
    dirty = true
  }

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const flat = []
      for (const child of children) {
        if (Array.isArray(child)) flat.push(...child)
        else flat.push(child)
      }
      return { type, props: { ...(props ?? {}), children: flat.length <= 1 ? flat[0] : flat } }
    },
    useState(initial) {
      const { state } = slot()
      if (!('value' in state)) state.value = typeof initial === 'function' ? initial() : initial
      return [
        state.value,
        (next) => {
          const value = typeof next === 'function' ? next(state.value) : next
          if (value === state.value) return
          state.value = value
          markDirty()
        },
      ]
    },
    useRef(initial) {
      const { state } = slot()
      if (!('ref' in state)) state.ref = { current: initial }
      return state.ref
    },
    useMemo(factory, deps) {
      const { state } = slot()
      const prev = state.memo
      const same = prev !== undefined && deps !== undefined && prev.deps.length === deps.length && prev.deps.every((d, i) => Object.is(d, deps[i]))
      if (!same) state.memo = { deps: deps ?? [], value: factory() }
      return state.memo.value
    },
    useEffect(effect, deps) {
      const { node, state, index } = slot()
      const prev = state.effect
      const same = prev !== undefined && (deps === undefined || (prev.deps !== undefined && prev.deps.length === deps.length && prev.deps.every((d, i) => Object.is(d, deps[i]))))
      if (same) return
      state.effect = { deps }
      pendingEffects.push({ node, index, effect })
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const { state } = slot()
      if (!state.subscribed) {
        state.subscribed = true
        state.unsubscribe = subscribe(markDirty)
      }
      return getSnapshot()
    },
  }

  function renderChildren(children, path) {
    if (children === undefined || children === null) return []
    const list = Array.isArray(children) ? children : [children]
    const out = []
    list.forEach((child, index) => {
      const rendered = renderNode(child, `${path}.${index}`)
      if (rendered !== null) out.push(rendered)
    })
    return out
  }

  function renderNode(element, path) {
    if (element === null || element === undefined || element === false || element === true) return null
    if (typeof element === 'string' || typeof element === 'number') return String(element)
    if (Array.isArray(element)) return renderChildren(element, path)
    const type = element.type
    const props = element.props ?? {}
    if (typeof type === 'function') {
      const name = type.name || 'Anonymous'
      const childPath = `${path}/${name}`
      const node = nodeAt(childPath)
      node.cursor = 0
      const outer = currentPath
      currentPath = childPath
      let output
      try {
        output = type(props)
      } finally {
        currentPath = outer
      }
      return renderNode(output, childPath)
    }
    return {
      tag: typeof type === 'string' ? type : String(type),
      props: { ...props, children: undefined },
      children: renderChildren(props.children, path),
    }
  }

  /** Run queued effects, then any re-render they caused, until stable. */
  function commit() {
    let guard = 0
    while ((pendingEffects.length > 0 || dirty) && guard < 50) {
      guard += 1
      dirty = false
      const effects = pendingEffects.splice(0, pendingEffects.length)
      for (const entry of effects) {
        const cleanup = entry.effect()
        const slotState = entry.node.hooks[entry.index]
        if (typeof cleanup === 'function') slotState.cleanup = cleanup
      }
    }
  }

  /** Render a root element and settle every effect it triggers. */
  function renderRoot(element) {
    let tree = null
    let guard = 0
    dirty = true
    while (dirty && guard < 50) {
      guard += 1
      dirty = false
      rendering = true
      try {
        tree = renderNode(element, 'root')
      } finally {
        rendering = false
      }
      commit()
    }
    return tree
  }

  /** Let promises settle, then re-render (used after async loaders). */
  async function settle(element) {
    for (let i = 0; i < 12; i += 1) {
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (dirty) {
        renderRoot(element)
      }
    }
    return renderRoot(element)
  }

  /** Depth-first text of a rendered tree, for assertions. */
  function textOf(tree) {
    const parts = []
    const walk = (node) => {
      if (node === null || node === undefined) return
      if (typeof node === 'string') {
        parts.push(node)
        return
      }
      if (Array.isArray(node)) {
        node.forEach(walk)
        return
      }
      walk(node.children)
    }
    walk(tree)
    return parts.join(' ')
  }

  /** Every node whose `tag` matches, depth-first. */
  function findAll(tree, tag) {
    const out = []
    const walk = (node) => {
      if (node === null || node === undefined || typeof node === 'string') return
      if (Array.isArray(node)) {
        node.forEach(walk)
        return
      }
      if (node.tag === tag) out.push(node)
      walk(node.children)
    }
    walk(tree)
    return out
  }

  /** The first node whose className contains `className`. */
  function findClass(tree, className) {
    const out = []
    const walk = (node) => {
      if (node === null || node === undefined || typeof node === 'string') return
      if (Array.isArray(node)) {
        node.forEach(walk)
        return
      }
      const cls = node.props && node.props.className
      if (typeof cls === 'string' && cls.includes(className)) out.push(node)
      walk(node.children)
    }
    walk(tree)
    return out[0] ?? null
  }

  return { React, renderRoot, settle, textOf, findAll, findClass, markDirty }
}
