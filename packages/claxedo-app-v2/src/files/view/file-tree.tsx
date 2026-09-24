import { createMemo, For, Match, Show, Switch, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useTranslator } from "@/i18n"
import { FailureNotice } from "@/lib/failure"
import type { FileNode, PlacementId } from "@/server"
import { useWorkbench } from "@/workbench"
import { useFilesApi } from "../api"
import { dictionary } from "../i18n"
import { changeMarks, fetchView, sortNodes, treeKeyAction, type ChangeMark } from "../model"
import { filePaneKind } from "../pane"
import { useFiles } from "../store"
import { FileTreeRow } from "./file-tree-row"
import { PlaceholderRows } from "./placeholder"

type Marks = ReadonlyMap<string, ChangeMark>

function handleTreeKeys(event: KeyboardEvent & { currentTarget: HTMLDivElement }) {
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]'))
  const current = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[role="treeitem"]') : null
  const expandedAttr = current?.getAttribute("aria-expanded")
  const action = treeKeyAction({
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

export function FileTree(props: { readonly placementId: PlacementId; readonly activePath?: string }): JSX.Element {
  const t = useTranslator(dictionary)
  const api = useFilesApi()
  const status = useQuery(() => api.changes(props.placementId))
  const marks = createMemo(() => changeMarks(status.data))
  return (
    <div role="tree" aria-label={t("files.tree")} class="flex flex-col gap-0.5 p-1" onKeyDown={handleTreeKeys}>
      <TreeLevel placementId={props.placementId} dir="" level={0} marks={marks()} activePath={props.activePath} />
    </div>
  )
}

function TreeLevel(props: {
  readonly placementId: PlacementId
  readonly dir: string
  readonly level: number
  readonly marks: Marks
  readonly activePath?: string
}): JSX.Element {
  const t = useTranslator(dictionary)
  const api = useFilesApi()
  const files = useFiles()
  const workbench = useWorkbench()
  const query = useQuery(() => api.tree(props.placementId, props.dir))
  const view = createMemo(() => fetchView(query))
  const failed = createMemo(() => {
    const current = view()
    return current.kind === "failed" ? current.error : undefined
  })
  const nodes = createMemo(() => {
    const current = view()
    return current.kind === "ready" ? sortNodes(current.data) : []
  })
  const activate = (node: FileNode) => {
    if (node.kind === "directory") files.setExpanded(node.path, !files.expanded(node.path))
    else workbench.openPane(filePaneKind, { placementId: props.placementId, path: node.path })
  }
  return (
    <Switch>
      <Match when={view().kind === "loading"}>
        <PlaceholderRows label={t("files.loading")} rows={props.level === 0 ? 5 : 2} />
      </Match>
      <Match when={failed()}>
        {(error) => (
          <FailureNotice title={t("files.loadFailed")} message={error().message} retryLabel={t("files.retry")} onRetry={() => void query.refetch()} />
        )}
      </Match>
      <Match when={view().kind === "ready"}>
        <div role={props.level === 0 ? undefined : "group"} class="flex flex-col gap-0.5">
          <For each={nodes()}>
            {(node) => (
              <>
                <FileTreeRow
                  node={node}
                  level={props.level}
                  expanded={node.kind === "directory" ? files.expanded(node.path) : undefined}
                  mark={props.marks.get(node.path)}
                  active={props.activePath === node.path}
                  onActivate={() => activate(node)}
                />
                <Show when={node.kind === "directory" && files.expanded(node.path)}>
                  <TreeLevel
                    placementId={props.placementId}
                    dir={node.path}
                    level={props.level + 1}
                    marks={props.marks}
                    activePath={props.activePath}
                  />
                </Show>
              </>
            )}
          </For>
        </div>
      </Match>
    </Switch>
  )
}
