import { useFile } from "@/app/providers/file"
import { encodeFilePath } from "@/platform/files/path"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { ClaxedoIcon as Icon, ClaxedoIconV2 as IconV2 } from "@/ui/controls/claxedo-icon"
import { createEffect, createMemo, createSignal, For, Match, Show, omit, Switch, type ParentProps } from "solid-js"
import type { ComponentProps } from "@solidjs/web"
import { Dynamic } from "@solidjs/web"
import type { FileNode } from "@opencode-ai/sdk/v2"
import {
  buildAllowedFilter,
  dirsToExpand,
  fileTreeRevealWindow,
  leafName,
  parentPath,
  resolveTreeKeyAction,
  shouldListExpanded,
  shouldListRoot,
  type FileTreeFilter as Filter,
} from "../../../ui/controls/file-tree-helpers"

const MAX_DEPTH = 128

function pathToFileUrl(filepath: string): string {
  return `file://${encodeFilePath(filepath)}`
}

type Kind = "add" | "del" | "mix"

const kindLabel = (kind: Kind) => {
  if (kind === "add") return "A"
  if (kind === "del") return "D"
  return "M"
}

const kindTextColor = (kind: Kind) => {
  if (kind === "add") return "color: var(--icon-diff-add-base)"
  if (kind === "del") return "color: var(--icon-diff-delete-base)"
  return "color: var(--icon-diff-modified-base)"
}

const kindDotColor = (kind: Kind) => {
  if (kind === "add") return "background-color: var(--icon-diff-add-base)"
  if (kind === "del") return "background-color: var(--icon-diff-delete-base)"
  return "background-color: var(--icon-diff-modified-base)"
}

const visibleKind = (node: FileNode, kinds?: ReadonlyMap<string, Kind>, marks?: Set<string>) => {
  const kind = kinds?.get(node.path)
  if (!kind) return
  if (!marks?.has(node.path)) return
  return kind
}

const buildDragImage = (target: HTMLElement) => {
  const icon = target.querySelector('[data-component="file-icon"]') ?? target.querySelector("svg")
  const text = target.querySelector("span")
  if (!icon || !text) return

  const image = document.createElement("div")
  image.className =
    "flex items-center gap-x-2 px-2 py-1 bg-surface-raised-base rounded-md border border-border-base text-12-regular text-text-strong"
  image.style.position = "absolute"
  image.style.top = "-1000px"
  image.innerHTML = (icon as SVGElement).outerHTML + (text as HTMLSpanElement).outerHTML
  return image
}

const withFileDragImage = (event: DragEvent) => {
  const image = buildDragImage(event.currentTarget as HTMLElement)
  if (!image) return
  document.body.appendChild(image)
  event.dataTransfer?.setDragImage(image, 0, 12)
  setTimeout(() => document.body.removeChild(image), 0)
}

const FileTreeNode = (
  p: ParentProps &
    ComponentProps<"div"> &
    ComponentProps<"button"> & {
      node: FileNode
      level: number
      active?: string
      nodeClass?: string
      dragEnabled: boolean
      kinds?: ReadonlyMap<string, Kind>
      marks?: Set<string>
      as?: "div" | "button"
    },
) => {
  const local = p,
    rest = omit(p, "node", "level", "active", "nodeClass", "dragEnabled", "kinds", "marks", "as", "children", "class")
  const kind = () => visibleKind(local.node, local.kinds, local.marks)
  const active = () => !!kind() && !local.node.ignored
  const color = () => {
    const value = kind()
    if (!value) return
    return kindTextColor(value)
  }

  return (
    <Dynamic
      component={local.as ?? "div"}
      data-file-tree-row={local.node.path}
      class={[
        local.class,
        {
          "w-full min-w-0 h-6 flex items-center justify-start gap-x-1.5 rounded-md px-1.5 py-0 text-left hover:bg-surface-raised-base-hover active:bg-surface-base-active transition-colors cursor-pointer": true,
          "bg-surface-base-active": local.node.path === local.active,
          [local.nodeClass ?? ""]: !!local.nodeClass,
        },
      ]}
      style={`padding-left: ${Math.max(0, 8 + local.level * 12 - (local.node.type === "file" ? 24 : 4))}px`}
      draggable={local.dragEnabled ? "true" : "false"}
      onDragStart={(event: DragEvent) => {
        if (!local.dragEnabled) return
        event.dataTransfer?.setData("text/plain", `file:${local.node.path}`)
        event.dataTransfer?.setData("text/uri-list", pathToFileUrl(local.node.path))
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy"
        withFileDragImage(event)
      }}
      {...rest}
    >
      {local.children}
      <span
        class={{
          "flex-1 min-w-0 text-12-medium whitespace-nowrap truncate": true,
          "text-text-weaker": local.node.ignored,
          "text-text-weak": !local.node.ignored && !active(),
        }}
        style={active() ? color() : undefined}
      >
        {local.node.name}
      </span>
      {(() => {
        const value = kind()
        if (!value) return null
        if (local.node.type === "file") {
          return (
            <span class="shrink-0 w-4 text-center text-12-medium" style={kindTextColor(value)}>
              {kindLabel(value)}
            </span>
          )
        }
        return <div class="shrink-0 size-1.5 mr-1.5 rounded-full" style={kindDotColor(value)} />
      })()}
    </Dynamic>
  )
}

export default function FileTree(props: {
  path: string
  class?: string
  nodeClass?: string
  active?: string
  /** Retain the rendered tree without starting directory reads while hidden. */
  enabled?: boolean
  level?: number
  allowed?: readonly string[]
  extensions?: readonly string[]
  modified?: readonly string[]
  kinds?: ReadonlyMap<string, Kind>
  draggable?: boolean
  visibleLimit?: number
  onFileClick?: (file: FileNode) => void
  onFilePointerEnter?: (file: FileNode) => void
  onFilePointerLeave?: (file: FileNode) => void

  _filter?: Filter
  _marks?: Set<string>
  _deeps?: Map<string, number>
  _kinds?: ReadonlyMap<string, Kind>
  _chain?: readonly string[]
  _extensions?: readonly string[]
}) {
  const file = useFile()
  const level = props.level ?? 0
  const draggable = () => props.draggable ?? true

  // Container-level WAI-ARIA tree keyboard navigation (root only — nested
  // FileTree instances bubble their keydowns up to this handler). Rows are the
  // focusable [role="treeitem"] elements (Kobalte trigger button for a
  // directory, the file button for a file); expanded state is read from the
  // trigger's aria-expanded so expand/collapse reuses the existing click path.
  const handleTreeKeyDown = (event: KeyboardEvent) => {
    const root = event.currentTarget as HTMLElement | null
    if (!root) return
    const items = Array.from(root.querySelectorAll<HTMLElement>('[role="treeitem"]'))
    const current = (event.target as HTMLElement | null)?.closest<HTMLElement>('[role="treeitem"]') ?? null
    const index = current ? items.indexOf(current) : -1
    const expandedAttr = current?.getAttribute("aria-expanded")
    const expanded = expandedAttr === null || expandedAttr === undefined ? undefined : expandedAttr === "true"
    const action = resolveTreeKeyAction({ key: event.key, index, count: items.length, expanded })
    if (action.kind === "none") return
    event.preventDefault()
    if (action.kind === "toggle") {
      current?.click()
      return
    }
    items[action.index]?.focus()
  }

  const batchSize = () => props.visibleLimit ?? Number.POSITIVE_INFINITY
  // Batches the reader has asked for on either side of the revealed window.
  const [batchesBefore, setBatchesBefore] = createSignal(0)
  const [batchesAfter, setBatchesAfter] = createSignal(0)

  const key = (p: string) =>
    file
      .normalize(p)
      .replace(/[\\/]+$/, "")
      .replaceAll("\\", "/")
  const chain = props._chain ? [...props._chain, key(props.path)] : [key(props.path)]

  const filter = createMemo(() => {
    if (props._filter) return props._filter

    const allowed = props.allowed
    if (!allowed) return

    return buildAllowedFilter(allowed)
  })

  const marks = createMemo(() => {
    if (props._marks) return props._marks

    const out = new Set<string>()
    for (const item of props.modified ?? []) out.add(item)
    for (const item of props.kinds?.keys() ?? []) out.add(item)
    if (out.size === 0) return
    return out
  })

  const kinds = createMemo(() => {
    if (props._kinds) return props._kinds
    return props.kinds
  })

  const deeps = createMemo(() => {
    if (props._deeps) return props._deeps

    const out = new Map<string, number>()

    const root = props.path
    if (!(file.tree.state(root)?.expanded ?? false)) return out

    const seen = new Set<string>()
    const stack: { dir: string; lvl: number; i: number; kids: string[]; max: number }[] = []

    const push = (dir: string, lvl: number) => {
      const id = key(dir)
      if (seen.has(id)) return
      seen.add(id)

      const kids = file.tree
        .children(dir)
        .filter((node) => node.type === "directory" && (file.tree.state(node.path)?.expanded ?? false))
        .map((node) => node.path)

      stack.push({ dir, lvl, i: 0, kids, max: lvl })
    }

    push(root, level - 1)

    while (stack.length > 0) {
      const top = stack[stack.length - 1]!

      if (top.i < top.kids.length) {
        const next = top.kids[top.i]!
        top.i++
        push(next, top.lvl + 1)
        continue
      }

      out.set(top.dir, top.max)
      stack.pop()

      const parent = stack[stack.length - 1]
      if (!parent) continue
      parent.max = Math.max(parent.max, top.max)
    }

    return out
  })

  // `enabled` gates the directory READS while the tree stays mounted, so it
  // belongs in the tracked compute of each effect below: flipping it back on
  // must re-trigger the read it suppressed.
  createEffect(
    () => (props.enabled === false ? undefined : filter()),
    (current) => {
      if (!current) return
      // apply phase runs untracked: the tree-state reads below no longer
      // subscribe, and the `expand` writes are glitch-free.
      const dirs = dirsToExpand({
        level,
        filter: current,
        expanded: (dir) => file.tree.state(dir)?.expanded ?? false,
      })
      for (const dir of dirs) file.tree.expand(dir)
    },
  )

  createEffect(
    () => (props.enabled === false ? undefined : props.path),
    (path) => {
      if (path === undefined) return
      // apply phase is untracked; the tree-state read needs no `untrack`.
      const dir = file.tree.state(path)
      if (!shouldListRoot({ level, dir })) return
      void file.tree.list(path)
    },
    { defer: false },
  )

  createEffect(
    () => props.enabled !== false && shouldListExpanded({ level, dir: file.tree.state(props.path) }) && props.path,
    (path) => {
      if (path === false) return
      void file.tree.list(path)
    },
  )

  // When extensions filter is active, eagerly load immediate child directories
  // so hasMatchingFile can evaluate them instead of defaulting to visible.
  createEffect(
    () => {
      if (props.enabled === false) return []
      const exts = props._extensions ?? props.extensions
      if (!exts || exts.length === 0) return []
      return file.tree
        .children(props.path)
        .filter((child) => child.type === "directory")
        .filter((child) => {
          const state = file.tree.state(child.path)
          return !state?.loaded && !state?.loading
        })
        .map((child) => child.path)
    },
    (pending) => {
      for (const path of pending) void file.tree.list(path)
    },
  )

  const hasMatchingFile = (dirPath: string, exts: string[]): boolean => {
    const st = file.tree.state(dirPath)
    if (!st?.loaded) return true // not loaded yet — keep visible
    for (const child of file.tree.children(dirPath)) {
      if (child.type === "file") {
        const lower = child.path.toLowerCase()
        if (exts.some((ext) => lower.endsWith(ext))) return true
      } else if (child.type === "directory") {
        if (hasMatchingFile(child.path, exts)) return true
      }
    }
    return false
  }

  const nodes = createMemo(() => {
    const nodes = file.tree.children(props.path)
    const current = filter()
    if (!current) {
      const exts = (props._extensions ?? props.extensions ?? []).map((ext) => ext.toLowerCase())
      if (exts.length === 0) return nodes
      return nodes.filter((node) => {
        if (node.type === "directory") return hasMatchingFile(node.path, exts)
        const value = node.path.toLowerCase()
        return exts.some((ext) => value.endsWith(ext))
      })
    }

    const parent = parentPath
    const leaf = leafName

    const out = nodes.filter((node) => {
      if (node.type === "file") return current.files.has(node.path)
      return current.dirs.has(node.path)
    })

    const seen = new Set(out.map((node) => node.path))

    for (const dir of current.dirs) {
      if (parent(dir) !== props.path) continue
      if (seen.has(dir)) continue
      out.push({
        name: leaf(dir),
        path: dir,
        absolute: dir,
        type: "directory",
        ignored: false,
      })
      seen.add(dir)
    }

    for (const item of current.files) {
      if (parent(item) !== props.path) continue
      if (seen.has(item)) continue
      out.push({
        name: leaf(item),
        path: item,
        absolute: item,
        type: "file",
        ignored: false,
      })
      seen.add(item)
    }

    out.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })

    return out
  })
  // Reset the reveal window on a path/allowed change only. A fresh tuple every
  // run keeps the reset firing on every invalidation, as the single-phase
  // effect did; `batchSize()` stays out of the tracked half so a `visibleLimit`
  // change alone does not collapse the window.
  createEffect(
    () => [props.path, props.allowed] as const,
    () => {
      setBatchesBefore(0)
      setBatchesAfter(0)
    },
  )
  const revealWindow = createMemo(() =>
    fileTreeRevealWindow({
      paths: nodes().map((node) => node.path),
      active: props.active,
      batchSize: batchSize(),
      batchesBefore: batchesBefore(),
      batchesAfter: batchesAfter(),
    }),
  )
  const visibleNodes = createMemo(() => nodes().slice(revealWindow().start, revealWindow().end))
  const hiddenBefore = createMemo(() => revealWindow().start)
  const hiddenAfter = createMemo(() => Math.max(0, nodes().length - revealWindow().end))
  const loadingEmpty = createMemo(() => {
    const dir = file.tree.state(props.path)
    return !!dir?.loading && nodes().length === 0
  })

  return (
    <div
      data-component="filetree"
      class={`flex flex-col gap-0.5 ${props.class ?? ""}`}
      role={level === 0 ? "tree" : "group"}
      aria-label={level === 0 ? "File tree" : undefined}
      onKeyDown={level === 0 ? handleTreeKeyDown : undefined}
    >
      <Show when={loadingEmpty()}>
        <div data-file-tree-loading class="flex flex-col gap-0.5 p-1" aria-label="Loading files">
          <For each={Array.from({ length: level === 0 ? 8 : 3 })}>
            {(_, index) => (
              <div
                class="h-6 rounded-md bg-surface-base"
                style={{
                  "margin-left": `${Math.max(0, 8 + level * 12)}px`,
                  width: `${Math.max(46, 82 - index() * 5)}%`,
                }}
              />
            )}
          </For>
        </div>
      </Show>
      <Show when={hiddenBefore() > 0}>
        <button
          type="button"
          class="mx-1 flex h-7 items-center justify-center rounded-md text-12-medium text-text-weak transition-colors hover:bg-surface-raised-base-hover hover:text-text-base"
          onClick={() => setBatchesBefore((current) => current + 1)}
        >
          Show {Math.min(hiddenBefore(), batchSize())} more
        </button>
      </Show>
      <For each={visibleNodes()}>
        {(node) => {
          const expanded = () => file.tree.state(node.path)?.expanded ?? false
          const deep = () => deeps().get(node.path) ?? -1
          const kind = () => visibleKind(node, kinds(), marks())
          const active = () => !!kind() && !node.ignored

          return (
            <Switch>
              <Match when={node.type === "directory"}>
                <Collapsible
                  variant="ghost"
                  class="w-full"
                  data-scope="filetree"
                  open={expanded()}
                  onOpenChange={(open) => (open ? file.tree.expand(node.path) : file.tree.collapse(node.path))}
                >
                  <Collapsible.Trigger
                    role="treeitem"
                    aria-level={level + 1}
                    aria-selected={
                      (node.path === props.active) == null ? undefined : node.path === props.active ? "true" : "false"
                    }
                  >
                    <FileTreeNode
                      node={node}
                      level={level}
                      active={props.active}
                      nodeClass={props.nodeClass}
                      dragEnabled={draggable()}
                      kinds={kinds()}
                      marks={marks()}
                    >
                      <div class="flex size-4 items-center justify-center text-icon-weak-base transition-colors group-hover/filetree:text-icon-base">
                        <IconV2 name={expanded() ? "chevron-down" : "chevron-right"} size="small" />
                      </div>
                    </FileTreeNode>
                  </Collapsible.Trigger>
                  <Collapsible.Content class="relative pt-0.5">
                    <div
                      class={{
                        "absolute top-0 bottom-0 w-px pointer-events-none bg-border-weak-base opacity-0 transition-opacity duration-150 ease-out motion-reduce:transition-none": true,
                        "group-hover/filetree:opacity-100": expanded() && deep() === level,
                        "group-hover/filetree:opacity-50": !(expanded() && deep() === level),
                      }}
                      style={`left: ${Math.max(0, 8 + level * 12 - 4) + 8}px`}
                    />
                    <Show
                      when={level < MAX_DEPTH && !chain.includes(key(node.path))}
                      fallback={<div class="px-2 py-1 text-12-regular text-text-weak">...</div>}
                    >
                      <FileTree
                        path={node.path}
                        enabled={props.enabled}
                        level={level + 1}
                        allowed={props.allowed}
                        extensions={props.extensions}
                        modified={props.modified}
                        kinds={props.kinds}
                        active={props.active}
                        draggable={props.draggable}
                        visibleLimit={props.visibleLimit}
                        onFileClick={props.onFileClick}
                        onFilePointerEnter={props.onFilePointerEnter}
                        onFilePointerLeave={props.onFilePointerLeave}
                        _filter={filter()}
                        _marks={marks()}
                        _deeps={deeps()}
                        _kinds={kinds()}
                        _chain={chain}
                        _extensions={props._extensions ?? props.extensions}
                      />
                    </Show>
                  </Collapsible.Content>
                </Collapsible>
              </Match>
              <Match when={node.type === "file"}>
                <FileTreeNode
                  node={node}
                  level={level}
                  active={props.active}
                  nodeClass={props.nodeClass}
                  dragEnabled={draggable()}
                  kinds={kinds()}
                  marks={marks()}
                  as="button"
                  type="button"
                  role="treeitem"
                  aria-level={level + 1}
                  aria-selected={
                    (node.path === props.active) == null ? undefined : node.path === props.active ? "true" : "false"
                  }
                  data-file-tree-path={node.path}
                  onPointerEnter={() => props.onFilePointerEnter?.(node)}
                  onPointerLeave={() => props.onFilePointerLeave?.(node)}
                  onClick={() => props.onFileClick?.(node)}
                >
                  <div class="w-4 shrink-0" />
                  <Switch>
                    <Match when={node.ignored}>
                      <FileIcon
                        node={node}
                        class="size-4 filetree-icon filetree-icon--mono"
                        style="color: var(--icon-weak-base)"
                        mono
                      />
                    </Match>
                    <Match when={active()}>
                      <FileIcon
                        node={node}
                        class="size-4 filetree-icon filetree-icon--mono"
                        style={kindTextColor(kind()!)}
                        mono
                      />
                    </Match>
                    <Match when={!node.ignored}>
                      <span class="filetree-iconpair size-4">
                        <FileIcon
                          node={node}
                          class="size-4 filetree-icon filetree-icon--color opacity-0 group-hover/filetree:opacity-100"
                        />
                        <FileIcon
                          node={node}
                          class="size-4 filetree-icon filetree-icon--mono group-hover/filetree:opacity-0"
                          mono
                        />
                      </span>
                    </Match>
                  </Switch>
                </FileTreeNode>
              </Match>
            </Switch>
          )
        }}
      </For>
      <Show when={hiddenAfter() > 0}>
        <button
          type="button"
          class="mx-1 flex h-7 items-center justify-center rounded-md text-12-medium text-text-weak transition-colors hover:bg-surface-raised-base-hover hover:text-text-base"
          onClick={() => setBatchesAfter((current) => current + 1)}
        >
          Show {Math.min(hiddenAfter(), batchSize())} more
        </button>
      </Show>
    </div>
  )
}
