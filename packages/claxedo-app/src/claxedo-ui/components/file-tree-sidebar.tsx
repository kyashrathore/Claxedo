import { Show, createEffect, createMemo, createSignal } from "solid-js"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import type { FileDiff, UserMessage } from "@opencode-ai/sdk/v2"
import { useGlobalSDK, useGlobalSync } from "@opencode-ai/claxedo-app"
import FileTree from "@/components/file-tree"
import { DirectoryScope } from "./directory-scope"
import { useClaxedoLayout } from "../context/claxedo-layout"
import { sendFocusFile } from "../context/pane-bus"

export function FileTreeSidebar(props: {
  groupId: string
  directory?: string
  opened: boolean
  width: number
  mobile: boolean
  onResize: (width: number) => void
  onCollapse: () => void
  onCloseMobile: () => void
}) {
  const claxedo = useClaxedoLayout()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const [reviewLoading, setReviewLoading] = createSignal(false)
  const [reviewDiffs, setReviewDiffs] = createSignal<FileDiff[]>([])
  let reviewReq = 0

  const active = createMemo(() => claxedo.groupTabs(props.groupId).active())
  const reviewTab = createMemo(() => {
    const tab = active()
    if (!tab) return
    if (tab.type !== "review") return
    if (!tab.directory || !tab.sessionId || tab.sessionId === "new") return
    return tab
  })
  const reviewMode = createMemo(() => reviewTab()?.reviewMode ?? "session")

  const turnDiffs = createMemo(() => {
    const tab = reviewTab()
    if (!tab) return [] as FileDiff[]
    if (reviewMode() !== "session-turn") return [] as FileDiff[]
    const [store] = globalSync.child(tab.directory!)
    const users = (store.message[tab.sessionId!] ?? []).filter((msg): msg is UserMessage => msg.role === "user")
    return users.at(-1)?.summary?.diffs ?? []
  })

  createEffect(() => {
    const tab = reviewTab()
    if (!tab) {
      setReviewLoading(false)
      setReviewDiffs([])
      return
    }
    const mode = reviewMode()
    if (mode === "session-turn") {
      setReviewLoading(false)
      setReviewDiffs([])
      return
    }
    const mapped = mode
    const fromRef = tab.reviewFromRef
    const toRef = tab.reviewToRef
    if (mapped === "to-from" && (!fromRef || !toRef)) {
      setReviewLoading(false)
      setReviewDiffs([])
      return
    }
    const req = ++reviewReq
    setReviewLoading(true)
    void globalSDK.client.session
      .diff({
        sessionID: tab.sessionId!,
        directory: tab.directory!,
      })
      .then((result) => {
        if (req !== reviewReq) return
        setReviewDiffs(result.data ?? [])
      })
      .catch(() => {
        if (req !== reviewReq) return
        setReviewDiffs([])
      })
      .finally(() => {
        if (req !== reviewReq) return
        setReviewLoading(false)
      })
  })

  const visibleDiffs = createMemo(() => {
    if (!reviewTab()) return [] as FileDiff[]
    if (reviewMode() === "session-turn") return turnDiffs()
    return reviewDiffs()
  })

  const diffFiles = createMemo(() => {
    const seen = new Set<string>()
    return visibleDiffs().flatMap((item) => {
      if (!item.file || seen.has(item.file)) return []
      seen.add(item.file)
      return [item.file]
    })
  })

  const diffKinds = createMemo(() => {
    const out = new Map<string, "add" | "del" | "mix">()
    for (const item of visibleDiffs()) {
      if (!item.file) continue
      const status = (item.status ?? "").toLowerCase()
      if (status === "added" || status === "a") {
        out.set(item.file, "add")
        continue
      }
      if (status === "deleted" || status === "d") {
        out.set(item.file, "del")
        continue
      }
      const additions = item.additions ?? 0
      const deletions = item.deletions ?? 0
      out.set(item.file, additions > 0 && deletions === 0 ? "add" : additions === 0 && deletions > 0 ? "del" : "mix")
    }
    return out
  })

  const session = () => {
    const tab = active()
    if (!tab) return
    if (tab.sessionId && tab.sessionId !== "new") return tab.sessionId
    const layout = claxedo.multiPane.activeLayout(tab.id)
    if (!layout) return
    return Object.values(layout.contents).find(
      (item) =>
        (item.type === "session" || item.type === "review-workspace" || item.type === "context") &&
        item.sessionId &&
        item.sessionId !== "new",
    )?.sessionId
  }

  const focus = (tabId: string, path: string) => {
    if (sendFocusFile(tabId, path) > 0) return true
    setTimeout(() => {
      sendFocusFile(tabId, path)
    }, 0)
    return false
  }

  const openFile = (path: string) => {
    const dir = props.directory
    const tab = active()
    if (tab) {
      if (!focus(tab.id, path) && dir && !claxedo.multiPane.hasReviewWorkspace(tab.id)) {
        const sid = session()
        claxedo.multiPane.toggleReviewWorkspace(tab.id, dir, sid, sid ? "session" : "uncommitted")
      }
      if (props.mobile) props.onCloseMobile()
      return
    }
    if (!dir) return
    const id = claxedo.groupTabs(props.groupId).addReviewWorkspace(dir, "new", "Review", undefined, "uncommitted")
    if (id) focus(id, path)
    if (props.mobile) props.onCloseMobile()
  }

  const reviewActive = createMemo(() => !!reviewTab())
  const panelTitle = createMemo(() => (reviewActive() ? "Changed files" : "Files"))

  const TreePanel = () => (
    <div class="h-full flex flex-col overflow-hidden">
      <div class="h-10 px-3 flex items-center justify-between border-b border-border-weak-base text-13-medium text-text-strong">
        <span>{panelTitle()}</span>
        <Show when={reviewActive()}>
          <span class="text-11-regular text-text-weak">{diffFiles().length}</span>
        </Show>
      </div>
      <div class="flex-1 min-h-0 overflow-auto px-3 py-1">
        <Show when={!reviewActive()}>
          <FileTree
            path=""
            onFileClick={(node) => openFile(node.path)}
          />
        </Show>
        <Show when={reviewActive()}>
          <Show when={!reviewLoading()} fallback={<div class="px-2 py-2 text-12-regular text-text-weak">Loading changes...</div>}>
            <Show
              when={diffFiles().length > 0}
              fallback={<div class="mt-8 text-center text-12-regular text-text-weak">No changed files</div>}
            >
              <FileTree
                path=""
                allowed={diffFiles()}
                kinds={diffKinds()}
                draggable={false}
                active={reviewTab()?.reviewFocusPath}
                onFileClick={(node) => openFile(node.path)}
              />
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  )

  return (
    <Show when={props.opened}>
      <Show when={props.mobile}>
        <div class="fixed inset-0 z-[95] md:hidden">
          <div class="absolute inset-0 bg-black/50" onClick={props.onCloseMobile} />
          <aside class="absolute right-0 top-0 h-full w-[85vw] max-w-[420px] border-l border-border-weak-base bg-background-base shadow-xl">
            <Show when={props.directory}>
              {(dir) => (
                <DirectoryScope directory={dir()}>
                  <TreePanel />
                </DirectoryScope>
              )}
            </Show>
          </aside>
        </div>
      </Show>

      <Show when={!props.mobile}>
        <aside class="relative shrink-0 h-full border-l border-border-weak-base bg-background-base" style={{ width: `${props.width}px` }}>
          <Show when={props.directory}>
            {(dir) => (
              <DirectoryScope directory={dir()}>
                <TreePanel />
              </DirectoryScope>
            )}
          </Show>
          <ResizeHandle
            direction="horizontal"
            edge="start"
            size={props.width}
            min={220}
            max={560}
            collapseThreshold={160}
            onResize={props.onResize}
            onCollapse={props.onCollapse}
          />
        </aside>
      </Show>
    </Show>
  )
}
