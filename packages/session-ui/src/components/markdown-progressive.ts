const initialRows = 8
const batchRows = 4
const minimumRows = 20
const frames = new WeakMap<HTMLElement, number>()
const delays = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

type Trace = (name: string, started: number) => void

export function disposeProgressiveMarkdown(root: Element) {
  if (!(root instanceof HTMLElement)) return
  const frame = frames.get(root)
  if (frame !== undefined) cancelAnimationFrame(frame)
  const delay = delays.get(root)
  if (delay !== undefined) clearTimeout(delay)
  frames.delete(root)
  delays.delete(root)
}

export function stageMarkdownCollections(root: HTMLElement, trace?: Trace) {
  const collections = Array.from(root.querySelectorAll("ul, ol, tbody"))
    .filter((collection) => collection.children.length > minimumRows)
    .filter((collection, _, all) => !all.some((parent) => parent !== collection && parent.contains(collection)))
    .map((collection) => ({ collection, children: Array.from(collection.children), cursor: initialRows }))
  if (collections.length === 0) return

  collections.forEach((entry) => entry.children.slice(initialRows).forEach((node) => node.remove()))
  root.dataset.markdownProgressive = "pending"
  const completeImmediately = () => {
    collections.forEach((entry) => {
      while (entry.cursor < entry.children.length) entry.collection.appendChild(entry.children[entry.cursor++]!)
    })
    root.dataset.markdownProgressive = "complete"
  }
  let batch = 0
  const step = () => {
    frames.delete(root)
    if (!root.isConnected) {
      completeImmediately()
      return
    }
    const started = performance.now()
    collections.forEach((entry) => {
      const end = Math.min(entry.children.length, entry.cursor + batchRows)
      while (entry.cursor < end) entry.collection.appendChild(entry.children[entry.cursor++]!)
    })
    const pending = collections.some((entry) => entry.cursor < entry.children.length)
    if (batch++ === 0 || !pending) trace?.(`markdown.progressive.${pending ? "first" : "complete"}`, started)
    if (pending) {
      frames.set(root, requestAnimationFrame(step))
      return
    }
    root.dataset.markdownProgressive = "complete"
  }
  delays.set(root, setTimeout(() => {
    delays.delete(root)
    if (!root.isConnected) {
      completeImmediately()
      return
    }
    frames.set(root, requestAnimationFrame(step))
  }, 260))
}
