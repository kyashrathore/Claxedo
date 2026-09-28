import { For, Match, splitProps, Switch, type ComponentProps, type JSX, type ParentProps } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useTranslator } from "@/i18n"
import type { FileNode } from "@/server"
import { DelayedLoading, FileIcon } from "@/ui"
import { filesDictionary } from "../i18n"
import type { ChangeKind } from "../model"

export type TreeMarks = ReadonlySet<string> | undefined

const kindLabel = (kind: ChangeKind) => {
  if (kind === "add") return "A"
  if (kind === "del") return "D"
  return "M"
}

export const kindTextColor = (kind: ChangeKind) => {
  if (kind === "add") return "color: var(--icon-diff-add-base)"
  if (kind === "del") return "color: var(--icon-diff-delete-base)"
  return "color: var(--icon-diff-modified-base)"
}

const kindDotColor = (kind: ChangeKind) => {
  if (kind === "add") return "background-color: var(--icon-diff-add-base)"
  if (kind === "del") return "background-color: var(--icon-diff-delete-base)"
  return "background-color: var(--icon-diff-modified-base)"
}

export function visibleKind(
  node: FileNode,
  kinds: ReadonlyMap<string, ChangeKind> | undefined,
  marks: TreeMarks,
): ChangeKind | undefined {
  const kind = kinds?.get(node.path)
  if (!kind || !marks?.has(node.path)) return undefined
  return kind
}

function iconNode(node: FileNode) {
  return { path: node.path, type: node.kind }
}

function KindMark(props: { readonly node: FileNode; readonly kind: ChangeKind | undefined }): JSX.Element {
  return (
    <Switch>
      <Match when={props.kind && props.node.kind === "file" && props.kind}>
        {(kind) => (
          <span class="shrink-0 w-4 text-center text-12-medium" style={kindTextColor(kind())}>
            {kindLabel(kind())}
          </span>
        )}
      </Match>
      <Match when={props.kind}>
        {(kind) => <div class="shrink-0 size-1.5 mr-1.5 rounded-full" style={kindDotColor(kind())} />}
      </Match>
    </Switch>
  )
}

export function FileTreeNode(
  p: ParentProps &
    ComponentProps<"div"> &
    ComponentProps<"button"> & {
      readonly node: FileNode
      readonly level: number
      readonly active?: string
      readonly kinds?: ReadonlyMap<string, ChangeKind>
      readonly marks: TreeMarks
      readonly as?: "div" | "button"
    },
): JSX.Element {
  const [local, rest] = splitProps(p, [
    "node",
    "level",
    "active",
    "kinds",
    "marks",
    "as",
    "children",
    "class",
    "classList",
  ])
  const kind = () => visibleKind(local.node, local.kinds, local.marks)
  const marked = () => !!kind() && !local.node.ignored
  return (
    <Dynamic
      component={local.as ?? "div"}
      data-file-tree-row={local.node.path}
      classList={{
        "w-full min-w-0 h-6 flex items-center justify-start gap-x-1.5 rounded-md px-1.5 py-0 text-left hover:bg-surface-raised-base-hover active:bg-surface-base-active transition-colors cursor-pointer": true,
        "bg-surface-base-active": local.node.path === local.active,
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
      style={`padding-left: ${Math.max(0, 8 + local.level * 12 - (local.node.kind === "file" ? 24 : 4))}px`}
      {...rest}
    >
      {local.children}
      <span
        classList={{
          "flex-1 min-w-0 text-12-medium whitespace-nowrap truncate": true,
          "text-text-weaker": local.node.ignored,
          "text-text-weak": !local.node.ignored && !marked(),
        }}
        style={marked() ? kindTextColor(kind()!) : undefined}
      >
        {local.node.name}
      </span>
      <KindMark node={local.node} kind={kind()} />
    </Dynamic>
  )
}

export function FileRowIcon(props: { readonly node: FileNode; readonly kind: ChangeKind | undefined }): JSX.Element {
  return (
    <Switch>
      <Match when={props.node.ignored}>
        <FileIcon
          node={iconNode(props.node)}
          class="size-4 filetree-icon filetree-icon--mono"
          style="color: var(--icon-weak-base)"
          mono
        />
      </Match>
      <Match when={props.kind}>
        {(kind) => (
          <FileIcon
            node={iconNode(props.node)}
            class="size-4 filetree-icon filetree-icon--mono"
            style={kindTextColor(kind())}
            mono
          />
        )}
      </Match>
      <Match when={true}>
        <FileIcon node={iconNode(props.node)} class="size-4 filetree-icon filetree-icon--mono" mono />
      </Match>
    </Switch>
  )
}

export function TreeLoading(props: { readonly level: number }): JSX.Element {
  const t = useTranslator(filesDictionary)
  return (
    <div data-file-tree-loading class="flex flex-col gap-0.5 p-1" aria-label={t("files.loading")}>
      <DelayedLoading>
        <For each={Array.from({ length: props.level === 0 ? 8 : 3 })}>
          {(_, index) => (
            <div
              class="h-6 rounded-md bg-surface-base"
              style={{
                "margin-left": `${Math.max(0, 8 + props.level * 12)}px`,
                width: `${Math.max(46, 82 - index() * 5)}%`,
              }}
            />
          )}
        </For>
      </DelayedLoading>
    </div>
  )
}

export function ShowMore(props: { readonly count: number; readonly onClick: () => void }): JSX.Element {
  const t = useTranslator(filesDictionary)
  return (
    <button
      type="button"
      class="mx-1 flex h-7 items-center justify-center rounded-md text-12-medium text-text-weak transition-colors hover:bg-surface-raised-base-hover hover:text-text-base"
      onClick={() => props.onClick()}
    >
      {t("files.showMore", { count: props.count })}
    </button>
  )
}
