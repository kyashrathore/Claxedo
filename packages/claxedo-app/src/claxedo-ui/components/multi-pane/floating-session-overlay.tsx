/**
 * FloatingSessionOverlay
 *
 * Renders a session pane as a compact floating CompactPromptDock overlay
 * at the bottom of the multi-pane container. Used when a session leaf
 * is in "floating" mode (review-workspace takes full space, session
 * docks as a compact overlay).
 */

import { Show, For, createMemo, createSignal, type Accessor } from "solid-js"
import { useSync, useComments } from "@opencode-ai/claxedo-app"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { SessionTurn } from "@opencode-ai/ui/session-turn"
import { CompactPromptDock } from "../compact-prompt-dock"
import { DirectoryScope } from "../directory-scope"
import { SessionParamsProvider } from "../../context/session-params"
import { GroupIdProvider } from "../../context/group-id"
import { useClaxedoLayout, type PaneContent } from "../../context/claxedo-layout"
import { useSDK } from "@/context/sdk"

function FloatingSessionContent(props: {
  sessionId: string
  directory: string
  tabId: string
  groupId: string
  leafId: string
  onDock: () => void
  onClose: () => void
}) {
  const sync = useSync()
  const language = useLanguage()
  const prompt = usePrompt()
  const comments = useComments()
  const sdk = useSDK()
  const [responding, setResponding] = createSignal(false)

  const info = createMemo(() => sync.session.get(props.sessionId))
  const messages = createMemo(() => sync.data.message[props.sessionId] ?? [])
  const userMessages = createMemo(
    () => messages().filter((msg): msg is UserMessage => msg.role === "user"),
  )
  const todos = createMemo(() => sync.data.todo[props.sessionId] ?? [])
  const questionRequest = createMemo(() => sync.data.question[props.sessionId]?.[0])
  const permissionRequest = createMemo(() => sync.data.permission[props.sessionId]?.[0])
  const blocked = createMemo(() => !!questionRequest() || !!permissionRequest())

  const decide = (response: "once" | "always" | "reject") => {
    const perm = permissionRequest()
    if (!perm) return
    if (responding()) return
    setResponding(true)
    sdk.client.permission
      .respond({ sessionID: props.sessionId, permissionID: perm.id, response })
      .finally(() => setResponding(false))
  }

  return (
    <CompactPromptDock
      title={info()?.title}
      onToggle={props.onDock}
      showToggle
      dockMode="floating"
      t={language.t as (key: string, vars?: Record<string, string | number | boolean>) => string}
      questionRequest={questionRequest}
      permissionRequest={permissionRequest}
      blocked={blocked()}
      todos={todos()}
      promptReady={prompt.ready()}
      handoffPrompt={undefined}
      responding={responding()}
      onDecide={decide}
      inputRef={() => {}}
      newSessionWorktree="main"
      onNewSessionWorktreeReset={() => {}}
      onSubmit={() => comments.clear()}
      setPromptDockRef={() => {}}
      messages={
        <div class="overflow-y-auto">
          <For each={userMessages()}>
            {(message) => (
              <SessionTurn
                sessionID={props.sessionId}
                messageID={message.id}
                classes={{
                  root: "min-w-0 w-full relative",
                  content: "flex flex-col justify-between !overflow-visible",
                  container: "w-full px-4",
                }}
              />
            )}
          </For>
        </div>
      }
    />
  )
}

export function FloatingSessionOverlay(props: {
  tabId: string
  groupId: string
  leafId: string
  content: Accessor<PaneContent | undefined>
  onDock: () => void
  onClose: () => void
}) {
  const content = createMemo(() => props.content())
  const claxedo = useClaxedoLayout()
  const tabs = createMemo(() => claxedo.groupTabs(props.groupId))

  return (
    <Show when={content()?.type === "session" && content()?.directory && content()?.sessionId}>
      <div class="absolute left-1/2 bottom-2 z-20 w-[min(100%-1.5rem,48rem)] -translate-x-1/2 pointer-events-auto">
        <SessionParamsProvider
          sessionId={() => content()!.sessionId}
          directory={() => content()!.directory}
          groupId={() => props.groupId}
          tabId={() => props.tabId}
          leafId={() => props.leafId}
        >
          <GroupIdProvider groupId={props.groupId}>
            <DirectoryScope
              directory={content()!.directory}
              onNavigateToSession={(sessionId) => {
                const ta = tabs()
                const newTabId = ta.addSession(content()!.directory, sessionId, "Session")
                if (newTabId) ta.setActive(newTabId)
              }}
            >
              <FloatingSessionContent
                sessionId={content()!.sessionId!}
                directory={content()!.directory}
                tabId={props.tabId}
                groupId={props.groupId}
                leafId={props.leafId}
                onDock={props.onDock}
                onClose={props.onClose}
              />
            </DirectoryScope>
          </GroupIdProvider>
        </SessionParamsProvider>
      </div>
    </Show>
  )
}
