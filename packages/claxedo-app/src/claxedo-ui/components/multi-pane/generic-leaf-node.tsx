/**
 * GenericLeafNode
 *
 * Per-leaf renderer for multi-pane tabs. Renders pane content and a
 * compact pane header with split/create actions.
 */

import { For, Show, Switch, Match, Suspense, lazy, createMemo, type Accessor } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { DialogSettings } from "@opencode-ai/claxedo-app"
import { useClaxedoLayout, type PaneContent } from "../../context/claxedo-layout"
import { DirectoryScope } from "../directory-scope"
import { SDKProvider } from "@/context/sdk"
import { SessionParamsProvider } from "../../context/session-params"
import { GroupIdProvider } from "../../context/group-id"
import { GroupLayoutProvider } from "../group-layout-provider"
import { TabReview } from "../tab-review"
import { TabFile } from "../tab-file"
import { TabPage } from "../tab-page"
import { TabContext } from "../tab-context"
import { PaneTerminal } from "./pane-terminal"
import { getTerminalCommands } from "../../../components/settings-terminals"
import { pagesApi } from "../../../utils/pages-api"
import { requestTerminalFitOnPaneChange, requestTerminalFitOnPaneFocus } from "./terminal-fit"

const SessionPage = lazy(() => import("../../../overrides/pages/session"))

function Loading() {
  return (
    <div class="flex items-center justify-center h-full text-text-weak">
      <div class="size-6 rounded-full border-2 border-text-weak border-t-transparent animate-spin" />
    </div>
  )
}

function ContentPicker(props: {
  onSession: () => void
  onClaude: () => void
  onCodex: () => void
  onTerminal: () => void
  onPage: () => void
  onConfigure: () => void
  custom: Array<{ name: string; command: string }>
  onCustom: (cmd: { name: string; command: string }) => void
}) {
  return (
    <div class="flex size-full items-center justify-center text-text-weak p-4">
      <div class="flex w-full max-w-[360px] flex-col items-center gap-3">
        <Icon name="plus-small" size="small" />
        <span class="text-sm">Choose content for this pane</span>
        <div class="grid grid-cols-2 gap-2 w-full">
          <Button size="small" variant="secondary" class="justify-start" onClick={props.onSession}>
            Session
          </Button>
          <Button size="small" variant="secondary" class="justify-start" onClick={props.onClaude}>
            Claude
          </Button>
          <Button size="small" variant="secondary" class="justify-start" onClick={props.onCodex}>
            Codex
          </Button>
          <Button size="small" variant="secondary" class="justify-start" onClick={props.onTerminal}>
            Terminal
          </Button>
          <Button size="small" variant="secondary" class="justify-start" onClick={props.onPage}>
            Page
          </Button>
          <Button size="small" variant="ghost" class="justify-start" onClick={props.onConfigure}>
            Configure...
          </Button>
        </div>
        <Show when={props.custom.length > 0}>
          <div class="w-full border-t border-border-weak-base pt-2">
            <div class="text-[11px] uppercase tracking-wide text-text-weaker mb-2">Custom Terminals</div>
            <div class="grid grid-cols-1 gap-2 w-full">
              <For each={props.custom}>
                {(cmd) => (
                  <Button size="small" variant="secondary" class="justify-start" onClick={() => props.onCustom(cmd)}>
                    {cmd.name}
                  </Button>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
    </div>
  )
}

type GenericLeafNodeProps = {
  tabId: string
  groupId: string
  leafId: string
  content: Accessor<PaneContent | undefined>
  isFocused: Accessor<boolean>
  isZoomed: Accessor<boolean>
  isOnlyLeaf: Accessor<boolean>
  onClose: () => void
  onFocus: () => void
}

export function GenericLeafNode(props: GenericLeafNodeProps) {
  const claxedo = useClaxedoLayout()
  const dialog = useDialog()
  const dim = () => (props.isZoomed() ? 1 : props.isFocused() ? 1 : 0.7)

  const contentTitle = createMemo(() => {
    const content = props.content()
    if (!content) return "Empty"
    if (content.title) return content.title
    if (content.type === "session") return "Session"
    if (content.type === "terminal") return "Terminal"
    if (content.type === "file") return content.filePath?.split("/").at(-1) ?? "File"
    if (content.type === "review") return "Review"
    if (content.type === "page") return "Page"
    if (content.type === "context") return "Context"
    return content.type
  })

  const tabs = createMemo(() => claxedo.groupTabs(props.groupId))
  const terminalCommands = createMemo(() => getTerminalCommands())
  const directory = createMemo(() => {
    const value = props.content()?.directory
    if (value && value !== "__pages__") return value
    return claxedo.groupWorktree(props.groupId).default() ?? value ?? ""
  })

  const setPaneContent = (content: PaneContent) => {
    if (!content.directory) return
    claxedo.dispatch({
      type: "PaneContentSetRequested",
      tabId: props.tabId,
      leafId: props.leafId,
      content,
    })
    requestTerminalFitOnPaneChange()
  }

  const splitEmpty = (dir: "h" | "v") => {
    claxedo.dispatch({
      type: "PaneSplitRequested",
      tabId: props.tabId,
      leafId: props.leafId,
      dir,
    })
    requestTerminalFitOnPaneChange()
  }

  const addSessionContent = () => {
    const source = props.content()
    const refs = source?.intent?.name ? [source.intent.name] : undefined
    const target = directory()
    if (!target) return
    if (source?.type === "page") {
      setPaneContent({
        type: "session",
        directory: target,
        sessionId: "new",
        intent: {
          name: "chat",
          role: "assistant",
          refs,
          defaults: {
            agent: "doc",
          },
        },
      })
      return
    }
    setPaneContent({
      type: "session",
      directory: target,
      sessionId: "new",
      intent: refs
        ? {
            role: "assistant",
            refs,
          }
        : undefined,
    })
  }

  const addTerminalContent = (command?: string, title?: string) => {
    const target = directory()
    if (!target) return
    setPaneContent({
      type: "terminal",
      directory: target,
      terminalId: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      command,
      title: title || "Terminal",
    })
  }

  const addPageContent = () => {
    const target = directory()
    if (!target) return
    void pagesApi
      .create("Untitled")
      .then((page) => {
        setPaneContent({
          type: "page",
          directory: target,
          pageId: page.id,
          title: page.title,
        })
      })
      .catch((error) => {
        showToast({
          title: "Failed to create page",
          description: error instanceof Error ? error.message : String(error),
          variant: "error",
        })
      })
  }
  const customCommands = createMemo(() => terminalCommands().custom.filter((cmd) => !!cmd.name && !!cmd.command))

  const openSettings = () => {
    dialog.show(() => <DialogSettings />)
  }

  return (
    <div
      data-pane={props.leafId}
      class="group relative size-full min-w-0 min-h-0 overflow-hidden bg-background-base flex flex-col"
      style={{ opacity: String(dim()) }}
      onPointerDown={() => {
        props.onFocus()
        requestTerminalFitOnPaneFocus({ type: props.content()?.type })
      }}
    >
      <div class="shrink-0 h-8 flex items-center gap-2 px-2 border-b border-border-weaker-base/50 bg-background-stronger/80 backdrop-blur select-none">
        <div class="flex items-center gap-2 min-w-0 flex-1">
          <span class="text-[12px] font-medium text-text-weak whitespace-nowrap overflow-hidden text-ellipsis">
            {contentTitle()}
          </span>
        </div>

        <div class="flex items-center gap-1">
          <IconButton icon="layout-right" variant="ghost" onClick={() => splitEmpty("v")} aria-label="Split right" />
          <IconButton icon="layout-bottom" variant="ghost" onClick={() => splitEmpty("h")} aria-label="Split down" />

          <Show when={!props.isOnlyLeaf()}>
            <IconButton icon="close-small" variant="ghost" onClick={() => props.onClose()} aria-label="Close pane" />
          </Show>
        </div>
      </div>

      <div class="flex-1 min-h-0 h-full w-full overflow-hidden">
        <Show
          when={props.content()}
          fallback={
            <ContentPicker
              onSession={addSessionContent}
              onClaude={() => addTerminalContent(terminalCommands().claude, "Claude")}
              onCodex={() => addTerminalContent(terminalCommands().codex, "Codex")}
              onTerminal={() => addTerminalContent()}
              onPage={addPageContent}
              onConfigure={openSettings}
              custom={customCommands()}
              onCustom={(cmd) => addTerminalContent(cmd.command, cmd.name)}
            />
          }
        >
          {(content) => (
            <Switch
              fallback={
                <div class="flex items-center justify-center h-full text-text-weak">
                  Unknown content type: {content().type}
                </div>
              }
            >
              <Match when={content().type === "session" && content().directory}>
                <SessionParamsProvider
                  sessionId={() => content().sessionId}
                  directory={() => content().directory}
                  groupId={() => props.groupId}
                  tabId={() => props.tabId}
                  leafId={() => props.leafId}
                >
                  <GroupIdProvider groupId={props.groupId}>
                    <GroupLayoutProvider groupId={props.groupId}>
                      <DirectoryScope
                        directory={content().directory}
                        onNavigateToSession={(sessionId) => {
                          const ta = tabs()
                          const newTabId = ta.addSession(content().directory, sessionId, "Session")
                          if (newTabId) ta.setActive(newTabId)
                        }}
                      >
                        <Suspense fallback={<Loading />}>
                          <SessionPage />
                        </Suspense>
                      </DirectoryScope>
                    </GroupLayoutProvider>
                  </GroupIdProvider>
                </SessionParamsProvider>
              </Match>

              <Match when={content().type === "terminal" && content().directory}>
                <GroupIdProvider groupId={props.groupId}>
                  <DirectoryScope
                    directory={content().directory}
                    onNavigateToSession={(sessionId) => {
                      const ta = tabs()
                      const newTabId = ta.addSession(content().directory, sessionId, "Session")
                      if (newTabId) ta.setActive(newTabId)
                    }}
                  >
                    <PaneTerminal
                      tabId={props.tabId}
                      leafId={props.leafId}
                      groupId={props.groupId}
                      directory={content().directory}
                      terminalId={content().terminalId!}
                      command={content().command}
                      title={content().title}
                    />
                  </DirectoryScope>
                </GroupIdProvider>
              </Match>

              <Match when={content().type === "review" && content().directory && content().sessionId}>
                <GroupIdProvider groupId={props.groupId}>
                  <DirectoryScope
                    directory={content().directory}
                    onNavigateToSession={(sessionId) => {
                      const ta = tabs()
                      const newTabId = ta.addSession(content().directory, sessionId, "Session")
                      if (newTabId) ta.setActive(newTabId)
                    }}
                  >
                    <TabReview
                      sessionId={content().sessionId!}
                      mode={content().reviewMode ?? "session"}
                      fromRef={content().reviewFromRef}
                      toRef={content().reviewToRef}
                    />
                  </DirectoryScope>
                </GroupIdProvider>
              </Match>

              <Match when={content().type === "context" && content().directory && content().sessionId}>
                <GroupIdProvider groupId={props.groupId}>
                  <DirectoryScope
                    directory={content().directory}
                    onNavigateToSession={(sessionId) => {
                      const ta = tabs()
                      const newTabId = ta.addSession(content().directory, sessionId, "Session")
                      if (newTabId) ta.setActive(newTabId)
                    }}
                  >
                    <TabContext sessionId={content().sessionId!} />
                  </DirectoryScope>
                </GroupIdProvider>
              </Match>

              <Match when={content().type === "file" && content().directory && content().filePath}>
                <SDKProvider directory={() => content().directory}>
                  <TabFile path={content().filePath!} />
                </SDKProvider>
              </Match>

              <Match when={content().type === "page" && content().pageId}>
                <Show
                  when={content().directory && content().directory !== "__pages__"}
                  fallback={<TabPage pageId={content().pageId!} directory={content().directory} />}
                >
                  <GroupIdProvider groupId={props.groupId}>
                    <DirectoryScope
                      directory={content().directory}
                      onNavigateToSession={(sessionId) => {
                        const ta = tabs()
                        const newTabId = ta.addSession(content().directory, sessionId, "Session")
                        if (newTabId) ta.setActive(newTabId)
                      }}
                    >
                      <TabPage pageId={content().pageId!} directory={content().directory} />
                    </DirectoryScope>
                  </GroupIdProvider>
                </Show>
              </Match>
            </Switch>
          )}
        </Show>
      </div>
    </div>
  )
}
