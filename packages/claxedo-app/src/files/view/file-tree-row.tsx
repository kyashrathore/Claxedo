import { Match, Switch, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { FailureNotice } from "@/lib/failure"
import type { FileNode } from "@/server"
import { ClaxedoIconV2 as IconV2 } from "@/ui"
import { filesDictionary } from "../i18n"
import type { ChangeKind } from "../model"
import type { TreeRow } from "../tree-rows"
import type { TreeSource } from "../tree-source"
import { FileRowIcon, FileTreeNode, ShowMore, TreeLoading, visibleKind, type TreeMarks } from "./file-tree-node"

export type TreeRowContext = {
  readonly source: () => TreeSource
  readonly active: () => string | undefined
  readonly kinds: () => ReadonlyMap<string, ChangeKind> | undefined
  readonly marks: () => TreeMarks
  readonly showMore: (dir: string, side: "before" | "after") => void
  readonly onFileClick: (file: FileNode) => void
  readonly onFilePress: (file: FileNode) => void
}

function DirectoryRow(props: { readonly tree: TreeRowContext; readonly node: FileNode; readonly level: number }): JSX.Element {
  const expanded = () => props.tree.source().state(props.node.path).expanded
  const toggle = () => (expanded() ? props.tree.source().collapse(props.node.path) : props.tree.source().expand(props.node.path))
  return (
    <div class="ui-collapsible w-full" data-variant="ghost" data-scope="filetree">
      <button
        type="button"
        class="ui-collapsible-trigger"
        role="treeitem"
        aria-level={props.level + 1}
        aria-selected={props.node.path === props.tree.active()}
        aria-expanded={expanded()}
        data-file-tree-path={props.node.path}
        onClick={toggle}
      >
        <FileTreeNode node={props.node} level={props.level} active={props.tree.active()} kinds={props.tree.kinds()} marks={props.tree.marks()}>
          <div class="flex size-4 items-center justify-center text-icon-weak-base transition-colors">
            <IconV2 name={expanded() ? "chevron-down" : "chevron-right"} size="small" />
          </div>
        </FileTreeNode>
      </button>
    </div>
  )
}

function FileRow(props: { readonly tree: TreeRowContext; readonly node: FileNode; readonly level: number }): JSX.Element {
  return (
    <FileTreeNode
      node={props.node}
      level={props.level}
      active={props.tree.active()}
      kinds={props.tree.kinds()}
      marks={props.tree.marks()}
      as="button"
      type="button"
      role="treeitem"
      aria-level={props.level + 1}
      aria-selected={props.node.path === props.tree.active()}
      data-file-tree-path={props.node.path}
      onPointerDown={(event: PointerEvent) => event.button === 0 && props.tree.onFilePress(props.node)}
      onClick={() => props.tree.onFileClick(props.node)}
    >
      <div class="w-4 shrink-0" />
      <FileRowIcon node={props.node} kind={props.node.ignored ? undefined : visibleKind(props.node, props.tree.kinds(), props.tree.marks())} />
    </FileTreeNode>
  )
}

export function TreeRowView(props: { readonly tree: TreeRowContext; readonly row: TreeRow }): JSX.Element {
  const t = useTranslator(filesDictionary)
  return (
    <Switch>
      <Match when={props.row.kind === "node" && props.row}>
        {(row) => (
          <Switch fallback={<FileRow tree={props.tree} node={row().node} level={row().level} />}>
            <Match when={row().node.kind === "directory"}>
              <DirectoryRow tree={props.tree} node={row().node} level={row().level} />
            </Match>
          </Switch>
        )}
      </Match>
      <Match when={props.row.kind === "more" && props.row}>
        {(row) => <ShowMore count={row().count} onClick={() => props.tree.showMore(row().dir, row().side)} />}
      </Match>
      <Match when={props.row.kind === "loading" && props.row}>
        {(row) => <TreeLoading level={row().level} />}
      </Match>
      <Match when={props.row.kind === "failed" && props.row}>
        {(row) => <FailureNotice title={t("files.loadFailed")} message={row().error.message} retryLabel={t("files.retry")} onRetry={row().retry} />}
      </Match>
      <Match when={props.row.kind === "cycle"}>
        <div class="px-2 py-1 text-12-regular text-text-weak">...</div>
      </Match>
    </Switch>
  )
}
