import { createEffect, createMemo, createSignal, For, on, onMount, Show, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createVirtualizer } from "@tanstack/solid-virtual"
import { useTranslator } from "@/i18n"
import type { FileNode } from "@/server"
import { filesDictionary } from "../i18n"
import type { ChangeKind } from "../model"
import { treeRows, type RevealBatches, type TreeRow } from "../tree-rows"
import type { TreeSource } from "../tree-source"
import type { TreeMarks } from "./file-tree-node"
import { TreeRowView, type TreeRowContext } from "./file-tree-row"
import { createTreeKeys } from "./file-tree-keys"

const ROW_GAP = 2
const OVERSCAN = 12
const ESTIMATES: Readonly<Record<TreeRow["kind"], number>> = { node: 24, more: 28, loading: 8, failed: 64, cycle: 24 }

export type FileTreeProps = {
  readonly source: TreeSource
  readonly scroller: Accessor<HTMLElement | undefined>
  readonly active?: string
  readonly reveal?: string
  readonly modified?: readonly string[]
  readonly kinds?: ReadonlyMap<string, ChangeKind>
  readonly visibleLimit?: number
  readonly loadingEpisode?: string
  readonly onFileClick?: (file: FileNode) => void
}

function createBatches(source: () => TreeSource) {
  const [batches, setBatches] = createStore<Record<string, RevealBatches>>({})
  createEffect(on(source, () => setBatches((current) => Object.fromEntries(Object.keys(current).map((dir) => [dir, { before: 0, after: 0 }]))), { defer: true }))
  return {
    of: (dir: string): RevealBatches => batches[dir] ?? { before: 0, after: 0 },
    grow: (dir: string, side: "before" | "after") => {
      const current = batches[dir] ?? { before: 0, after: 0 }
      setBatches(dir, { ...current, [side]: current[side] + 1 })
    },
  }
}

function sameRow(a: TreeRow | undefined, b: TreeRow | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.kind !== b.kind) return false
  if (a.kind === "node" && b.kind === "node") return a.node === b.node && a.level === b.level
  if (a.kind === "more" && b.kind === "more") return a.count === b.count
  if (a.kind === "loading" && b.kind === "loading") return a.level === b.level
  if (a.kind === "failed" && b.kind === "failed") return a.error === b.error
  return a.kind === "cycle"
}

function createMarks(props: FileTreeProps) {
  return createMemo((): TreeMarks => {
    const out = new Set<string>([...(props.modified ?? []), ...(props.kinds?.keys() ?? [])])
    return out.size === 0 ? undefined : out
  })
}

export function FileTree(props: FileTreeProps): JSX.Element {
  const t = useTranslator(filesDictionary)
  const batches = createBatches(() => props.source)
  const rows = createMemo(() =>
    treeRows({ source: props.source, active: props.active, batchSize: props.visibleLimit ?? Number.POSITIVE_INFINITY, batches: batches.of }),
  )
  const indexByKey = createMemo(() => new Map(rows().map((row, index) => [row.key, index])))
  let container: HTMLDivElement | undefined
  const [margin, setMargin] = createSignal(0)
  onMount(() => {
    const scroller = props.scroller()
    if (!container || !scroller) return
    setMargin(container.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop)
  })
  const virtualizer = createVirtualizer<HTMLElement, HTMLDivElement>({
    get count() {
      return rows().length
    },
    getScrollElement: () => props.scroller() ?? null,
    estimateSize: (index) => ESTIMATES[rows()[index]?.kind ?? "node"],
    get getItemKey() {
      const current = rows()
      return (index: number) => current[index]?.key ?? `removed:${index}`
    },
    get scrollMargin() {
      return margin()
    },
    gap: ROW_GAP,
    overscan: OVERSCAN,
  })
  const visible = createMemo(() => virtualizer.getVirtualItems().map((item) => String(item.key)), [], {
    equals: (a, b) => a.length === b.length && a.every((key, index) => key === b[index]),
  })
  const starts = createMemo(() => new Map(virtualizer.getVirtualItems().map((item) => [String(item.key), item.start])))
  const marks = createMarks(props)
  const context: TreeRowContext = {
    source: () => props.source,
    active: () => props.active,
    kinds: () => props.kinds,
    marks,
    loadingEpisode: () => props.loadingEpisode,
    showMore: batches.grow,
    onFileClick: (file) => props.onFileClick?.(file),
  }
  const scrollTo = (index: number) => virtualizer.scrollToIndex(index, { align: "auto" })
  const keys = createTreeKeys({ rows, visible, container: () => container, scrollTo })
  const [pendingReveal, setPendingReveal] = createSignal<string>()
  createEffect(on(() => props.reveal, setPendingReveal))
  createEffect(
    on([pendingReveal, indexByKey], ([path, index]) => {
      const at = path === undefined ? undefined : index.get(path)
      if (at === undefined) return
      scrollTo(at)
      setPendingReveal(undefined)
    }),
  )
  return (
    <div
      ref={container}
      data-component="filetree"
      role="tree"
      aria-label={t("files.tree")}
      style={{ position: "relative", width: "100%", height: `${virtualizer.getTotalSize()}px` }}
      onKeyDown={keys.onKeyDown}
    >
      <For each={visible()}>
        {(key) => {
          const index = createMemo(() => indexByKey().get(key))
          const row = createMemo(() => rows()[indexByKey().get(key) ?? -1], undefined, { equals: sameRow })
          return (
            <div
              data-index={index()}
              ref={(element) => queueMicrotask(() => element.isConnected && virtualizer.measureElement(element))}
              style={{ position: "absolute", top: "0", left: "0", width: "100%", display: "flex", "flex-direction": "column", transform: `translateY(${(starts().get(key) ?? 0) - margin()}px)` }}
            >
              <Show when={row()}>{(current) => <TreeRowView tree={context} row={current()} />}</Show>
            </div>
          )
        }}
      </For>
    </div>
  )
}
