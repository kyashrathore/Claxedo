import { createEffect, createMemo, createSignal, For, Match, Show, Switch, untrack, type JSX } from "solid-js"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { useTranslator } from "@/i18n"
import { FailureNotice } from "@/lib/failure"
import type { FileNode } from "@/server"
import { ClaxedoIconV2 as IconV2 } from "@/ui"
import { dictionary } from "../i18n"
import type { ChangeKind } from "../model"
import type { TreeSource } from "../tree-source"
import {
  buildAllowedFilter,
  dirsToExpand,
  expandedDepths,
  fileTreeRevealWindow,
  filteredNodes,
  resolveTreeKeyAction,
  treeKey,
  type FileTreeFilter,
} from "../tree-helpers"
import { FileRowIcon, FileTreeNode, ShowMore, TreeLoading, visibleKind, type TreeMarks } from "./file-tree-node"

const MAX_DEPTH = 128

export type FileTreeProps = {
  readonly source: TreeSource
  readonly path: string
  readonly active?: string
  readonly enabled?: boolean
  readonly level?: number
  readonly allowed?: readonly string[]
  readonly modified?: readonly string[]
  readonly kinds?: ReadonlyMap<string, ChangeKind>
  readonly visibleLimit?: number
  readonly loadingEpisode?: string
  readonly onFileClick?: (file: FileNode) => void
  readonly onFilePointerEnter?: (file: FileNode) => void
  readonly onFilePointerLeave?: (file: FileNode) => void
  readonly _filter?: FileTreeFilter
  readonly _marks?: TreeMarks
  readonly _deeps?: ReadonlyMap<string, number>
  readonly _chain?: readonly string[]
}

const handleTreeKeyDown: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = (event) => {
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]'))
  const current = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[role="treeitem"]') : null
  const expandedAttr = current?.getAttribute("aria-expanded")
  const action = resolveTreeKeyAction({
    key: event.key,
    index: current ? items.indexOf(current) : -1,
    count: items.length,
    expanded: expandedAttr === null || expandedAttr === undefined ? undefined : expandedAttr === "true",
  })
  if (action.kind === "none") return
  event.preventDefault()
  if (action.kind === "toggle") current?.click()
  else items[action.index]?.focus()
}

function DirectoryRow(props: {
  readonly tree: FileTreeProps
  readonly node: FileNode
  readonly level: number
  readonly marks: TreeMarks
  readonly deeps: ReadonlyMap<string, number>
  readonly filter: FileTreeFilter | undefined
  readonly chain: readonly string[]
}): JSX.Element {
  const expanded = () => props.tree.source.state(props.node.path).expanded
  const deep = () => props.deeps.get(props.node.path) ?? -1
  return (
    <Collapsible
      variant="ghost"
      class="w-full"
      data-scope="filetree"
      forceMount={false}
      open={expanded()}
      onOpenChange={(open) =>
        open ? props.tree.source.expand(props.node.path) : props.tree.source.collapse(props.node.path)
      }
    >
      <Collapsible.Trigger
        role="treeitem"
        aria-level={props.level + 1}
        aria-selected={props.node.path === props.tree.active}
      >
        <FileTreeNode
          node={props.node}
          level={props.level}
          active={props.tree.active}
          kinds={props.tree.kinds}
          marks={props.marks}
        >
          <div class="flex size-4 items-center justify-center text-icon-weak-base transition-colors group-hover/filetree:text-icon-base">
            <IconV2 name={expanded() ? "chevron-down" : "chevron-right"} size="small" />
          </div>
        </FileTreeNode>
      </Collapsible.Trigger>
      <Collapsible.Content class="relative pt-0.5">
        <div
          classList={{
            "absolute top-0 bottom-0 w-px pointer-events-none bg-border-weak-base opacity-0 transition-opacity duration-150 ease-out motion-reduce:transition-none": true,
            "group-hover/filetree:opacity-100": expanded() && deep() === props.level,
            "group-hover/filetree:opacity-50": !(expanded() && deep() === props.level),
          }}
          style={`left: ${Math.max(0, 8 + props.level * 12 - 4) + 8}px`}
        />
        <Show
          when={props.level < MAX_DEPTH && !props.chain.includes(treeKey(props.node.path))}
          fallback={<div class="px-2 py-1 text-12-regular text-text-weak">...</div>}
        >
          <FileTree
            {...props.tree}
            path={props.node.path}
            level={props.level + 1}
            _filter={props.filter}
            _marks={props.marks}
            _deeps={props.deeps}
            _chain={props.chain}
          />
        </Show>
      </Collapsible.Content>
    </Collapsible>
  )
}

function FileRow(props: {
  readonly tree: FileTreeProps
  readonly node: FileNode
  readonly level: number
  readonly marks: TreeMarks
}): JSX.Element {
  return (
    <FileTreeNode
      node={props.node}
      level={props.level}
      active={props.tree.active}
      kinds={props.tree.kinds}
      marks={props.marks}
      as="button"
      type="button"
      role="treeitem"
      aria-level={props.level + 1}
      aria-selected={props.node.path === props.tree.active}
      data-file-tree-path={props.node.path}
      onPointerEnter={() => props.tree.onFilePointerEnter?.(props.node)}
      onPointerLeave={() => props.tree.onFilePointerLeave?.(props.node)}
      onClick={() => props.tree.onFileClick?.(props.node)}
    >
      <div class="w-4 shrink-0" />
      <FileRowIcon
        node={props.node}
        kind={props.node.ignored ? undefined : visibleKind(props.node, props.tree.kinds, props.marks)}
      />
    </FileTreeNode>
  )
}

function createTreeLevel(props: FileTreeProps, level: number) {
  const filter = createMemo(() => props._filter ?? (props.allowed ? buildAllowedFilter(props.allowed) : undefined))
  const marks = createMemo((): TreeMarks => {
    if (props._marks) return props._marks
    const out = new Set<string>([...(props.modified ?? []), ...(props.kinds?.keys() ?? [])])
    return out.size === 0 ? undefined : out
  })
  const deeps = createMemo(() => props._deeps ?? expandedDepths(props.source, props.path, level))
  createEffect(() => {
    if (props.enabled === false) return
    const dirs = dirsToExpand({
      level,
      filter: filter(),
      expanded: (dir) => untrack(() => props.source.state(dir).expanded),
    })
    for (const dir of dirs) props.source.expand(dir)
  })
  const nodes = createMemo(() => filteredNodes(props.source, props.path, filter()))
  return { filter, marks, deeps, nodes }
}

export function FileTree(props: FileTreeProps): JSX.Element {
  const t = useTranslator(dictionary)
  const level = props.level ?? 0
  const batchSize = () => props.visibleLimit ?? Number.POSITIVE_INFINITY
  const [batchesBefore, setBatchesBefore] = createSignal(0)
  const [batchesAfter, setBatchesAfter] = createSignal(0)
  const chain = [...(props._chain ?? []), treeKey(props.path)]
  const tree = createTreeLevel(props, level)
  createEffect(() => {
    void props.path
    void props.allowed
    setBatchesBefore(0)
    setBatchesAfter(0)
  })
  const reveal = createMemo(() =>
    fileTreeRevealWindow({
      paths: tree.nodes().map((node) => node.path),
      active: props.active,
      batchSize: batchSize(),
      batchesBefore: batchesBefore(),
      batchesAfter: batchesAfter(),
    }),
  )
  const hiddenAfter = () => Math.max(0, tree.nodes().length - reveal().end)
  const dir = () => props.source.state(props.path)
  return (
    <div
      data-component="filetree"
      class="flex flex-col gap-0.5"
      role={level === 0 ? "tree" : "group"}
      aria-label={level === 0 ? t("files.tree") : undefined}
      onKeyDown={level === 0 ? handleTreeKeyDown : undefined}
    >
      <Switch>
        <Match when={dir().error}>
          {(error) => (
            <FailureNotice
              title={t("files.loadFailed")}
              message={error().message}
              retryLabel={t("files.retry")}
              onRetry={dir().retry}
            />
          )}
        </Match>
        <Match when={dir().loading && tree.nodes().length === 0}>
          <TreeLoading level={level} episode={props.loadingEpisode} />
        </Match>
      </Switch>
      <Show when={reveal().start > 0}>
        <ShowMore
          count={Math.min(reveal().start, batchSize())}
          onClick={() => setBatchesBefore((current) => current + 1)}
        />
      </Show>
      <For each={tree.nodes().slice(reveal().start, reveal().end)}>
        {(node) => (
          <Show
            when={node.kind === "directory"}
            fallback={<FileRow tree={props} node={node} level={level} marks={tree.marks()} />}
          >
            <DirectoryRow
              tree={props}
              node={node}
              level={level}
              marks={tree.marks()}
              deeps={tree.deeps()}
              filter={tree.filter()}
              chain={chain}
            />
          </Show>
        )}
      </For>
      <Show when={hiddenAfter() > 0}>
        <ShowMore
          count={Math.min(hiddenAfter(), batchSize())}
          onClick={() => setBatchesAfter((current) => current + 1)}
        />
      </Show>
    </div>
  )
}
