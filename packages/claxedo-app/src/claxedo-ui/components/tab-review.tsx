import { Show, Match, Switch, For, createMemo, createEffect, createSignal } from "solid-js"
import { createStore } from "solid-js/store"

import { useSync, useFile, useComments } from "@opencode-ai/claxedo-app"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { selectionFromLines } from "@/context/file"
import {
  SessionReview,
  type SessionReviewLineComment,
} from "@opencode-ai/ui/session-review"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Mark } from "@opencode-ai/ui/logo"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import type { FileDiff, FileContent, UserMessage } from "@opencode-ai/sdk/v2"
import { SessionTurn } from "@opencode-ai/ui/session-turn"
import type { ReviewMode } from "../context/claxedo-layout/types"
import { CompactPromptDock } from "./compact-prompt-dock"
import { createDebugLogger } from "../../overrides/utils/debug"

export type TabReviewProps = {
  sessionId: string
  mode: ReviewMode
  fromRef?: string
  toRef?: string
  focusPath?: string
  focusVersion?: number
  onViewFile?: (path: string) => void
  class?: string
}

export function TabReview(props: TabReviewProps) {
  const sync = useSync()
  const file = useFile()
  const comments = useComments()
  const sdk = useSDK()
  const debug = createDebugLogger("layout.review-diff", "layout:review-diff", {
    legacyKey: "opencode.debug.terminal",
  })
  const language = useLanguage()
  const prompt = usePrompt()
  const [responding, setResponding] = createSignal(false)

  const [store, setStore] = createStore({
    openDiffs: [] as string[],
    diffStyle: "unified" as "unified" | "split",
    focusedFile: undefined as string | undefined,
    loading: false,
    remoteDiffs: [] as FileDiff[],
  })

  let reviewScrollRef: HTMLDivElement | undefined

  createEffect(() => {
    const id = props.sessionId
    if (!id || id === "new") return
    void sync.session.sync(id)
    if (props.mode !== "session") return
    if (sync.data.session_diff[id] !== undefined) return
    if (sync.status === "loading") return
    void sync.session.diff(id)
  })

  createEffect(() => {
    const id = props.sessionId
    if (!id || id === "new") return
    if (props.mode === "session" || props.mode === "session-turn") return
    const mode = props.mode === "committed" ? "to-from" : props.mode

    debug.log("fetch start", {
      sessionId: id,
      mode,
      displayMode: props.mode,
      fromRef: props.fromRef,
      toRef: props.toRef,
      directory: sdk.directory,
    })
    setStore("loading", true)
    void sdk.client.session
      .diff({
        sessionID: id,
        mode,
        fromRef: props.fromRef,
        toRef: props.toRef,
      })
      .then((result) => {
        const diffs = result.data ?? []
        debug.log("fetch success", {
          sessionId: id,
          mode,
          displayMode: props.mode,
          files: diffs.length,
          additions: diffs.reduce((sum, item) => sum + (item.additions ?? 0), 0),
          deletions: diffs.reduce((sum, item) => sum + (item.deletions ?? 0), 0),
        })
        setStore("remoteDiffs", diffs)
      })
      .catch((error: unknown) => {
        debug.log("fetch failed", {
          sessionId: id,
          mode,
          displayMode: props.mode,
          fromRef: props.fromRef,
          toRef: props.toRef,
          error: error instanceof Error ? error.message : String(error),
        })
        setStore("remoteDiffs", [])
      })
      .finally(() => {
        setStore("loading", false)
      })
  })

  const info = createMemo(() => sync.session.get(props.sessionId))
  const messages = createMemo(() => sync.data.message[props.sessionId] ?? [])
  const userMessages = createMemo(() => messages().filter((msg): msg is UserMessage => msg.role === "user"))
  const lastUserMessage = createMemo(() => {
    return userMessages().at(-1)
  })
  const todos = createMemo(() => sync.data.todo[props.sessionId] ?? [])
  const questionRequest = createMemo(() => sync.data.question[props.sessionId]?.[0])
  const permissionRequest = createMemo(() => sync.data.permission[props.sessionId]?.[0])
  const blocked = createMemo(() => !!questionRequest() || !!permissionRequest())

  const turnDiffs = createMemo(() => lastUserMessage()?.summary?.diffs ?? [])

  const diffs = createMemo((): FileDiff[] => {
    if (props.mode === "session-turn") return turnDiffs()
    if (props.mode === "session") return sync.data.session_diff[props.sessionId] ?? []
    return store.remoteDiffs
  })

  const hasReview = createMemo(() => diffs().length > 0)
  const reviewCount = createMemo(() => diffs().length)

  const totalChanges = createMemo(() => {
    const d = diffs()
    return {
      additions: d.reduce((acc, f) => acc + (f.additions ?? 0), 0),
      deletions: d.reduce((acc, f) => acc + (f.deletions ?? 0), 0),
    }
  })

  const diffsReady = createMemo(() => {
    if (props.mode !== "session") return !store.loading
    return messages().length > 0 || info() !== undefined
  })

  const readFile = async (path: string): Promise<FileContent | undefined> => {
    await file.load(path)
    const state = file.get(path)
    return state?.content
  }

  const handleLineComment = (comment: SessionReviewLineComment) => {
    const saved = comments.add({
      file: comment.file,
      selection: comment.selection,
      comment: comment.comment,
    })
    const selection = selectionFromLines(comment.selection)
    prompt.context.add({
      type: "file",
      path: comment.file,
      selection,
      comment: comment.comment,
      commentID: saved.id,
      commentOrigin: "review",
      preview: comment.preview,
    })
    debug.log("line comment added", {
      sessionId: props.sessionId,
      mode: props.mode,
      file: comment.file,
      commentID: saved.id,
    })
  }

  const handleViewFile = (path: string) => {
    file.load(path)
    props.onViewFile?.(path)
  }

  const handleOpenChange = (open: string[]) => {
    setStore("openDiffs", open)
  }

  const scrollToFile = (path: string) => {
    if (!reviewScrollRef) return
    const target = `[data-file="${(globalThis.CSS && CSS.escape ? CSS.escape(path) : path.replaceAll('"', '\\"'))}"]`
    const node = reviewScrollRef.querySelector(target)
    if (!(node instanceof HTMLElement)) return
    node.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  createEffect(() => {
    if (!props.focusVersion) return
    const path = props.focusPath
    if (!path) return
    const files = diffs().map((item) => item.file)
    if (!files.includes(path)) return
    setStore("focusedFile", path)
    setStore("openDiffs", [path])
    requestAnimationFrame(() => scrollToFile(path))
  })

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
    <div class={`relative flex size-full min-h-0 overflow-hidden bg-background-base ${props.class ?? ""}`}>
      <div class="relative flex-1 min-w-0 flex flex-col h-full">
        <div class="flex items-center justify-between gap-4 px-4 py-3 border-b border-border-weak-base bg-background-stronger flex-shrink-0">
          <div class="flex items-center gap-3 min-w-0">
            <div class="flex items-center gap-2 text-sm font-medium text-text-strong min-w-0">
              <span>Review</span>
              <Show when={reviewCount() > 0}>
                <span class="flex items-center justify-center min-w-5 h-5 px-1.5 text-xs font-medium text-text-strong bg-surface-base rounded-full">
                  {reviewCount()}
                </span>
              </Show>
            </div>
            <Show when={hasReview()}>
              <DiffChanges changes={totalChanges()} class="flex-shrink-0" />
            </Show>
          </div>

          <div class="flex items-center gap-2 flex-shrink-0">
            <Show when={hasReview()}>
              <div class="flex items-center gap-0.5 p-0.5 bg-surface-base rounded-md">
                <Tooltip value="Unified view">
                  <div class="flex items-center">
                    <IconButton
                      icon="code-lines"
                      variant={store.diffStyle === "unified" ? "secondary" : "ghost"}
                      onClick={() => setStore("diffStyle", "unified")}
                      aria-label="Unified view"
                    />
                  </div>
                </Tooltip>
                <Tooltip value="Split view">
                  <div class="flex items-center">
                    <IconButton
                      icon="layout-right"
                      variant={store.diffStyle === "split" ? "secondary" : "ghost"}
                      onClick={() => setStore("diffStyle", "split")}
                      aria-label="Split view"
                    />
                  </div>
                </Tooltip>
              </div>
            </Show>
          </div>
        </div>

        <div class="flex-1 min-h-0 overflow-auto" ref={reviewScrollRef}>
          <Switch>
            <Match when={hasReview()}>
              <Show
                when={diffsReady()}
                fallback={<div class="px-4 py-6 text-text-weak">Loading changes...</div>}
              >
                <SessionReview
                  diffs={diffs()}
                  diffStyle={store.diffStyle}
                  comments={comments.all()}
                  focusedComment={comments.focus()}
                  onFocusedCommentChange={comments.setFocus}
                  open={store.openDiffs}
                  onOpenChange={handleOpenChange}
                  readFile={readFile}
                  onLineComment={handleLineComment}
                  onViewFile={handleViewFile}
                  focusedFile={store.focusedFile}
                  classes={{
                    root: "h-full",
                    header: "px-4",
                    container: "px-4",
                  }}
                />
              </Show>
            </Match>

            <Match when={true}>
              <div class="flex flex-col items-center justify-center h-full min-h-[300px] px-6 pt-8 pb-30 text-center gap-6">
                <Mark class="w-14 opacity-10" />
                <div class="text-13-regular text-text-weak max-w-56">No changes for this review mode</div>
              </div>
            </Match>
          </Switch>
        </div>

        <div class="absolute left-1/2 bottom-2 z-10 w-[min(100%-1.5rem,48rem)] -translate-x-1/2 pointer-events-auto">
          <CompactPromptDock
            title={info()?.title}
            onToggle={() => {}}
            showToggle={false}
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
        </div>
      </div>
    </div>
  )
}

export function ReviewSummary(props: { sessionId: string; class?: string }) {
  const sync = useSync()

  const info = createMemo(() => sync.session.get(props.sessionId))
  const summary = createMemo(() => info()?.summary)

  return (
    <Show when={summary()}>
      {(s) => (
        <div class={`flex items-center gap-2 text-xs text-text-weak ${props.class ?? ""}`}>
          <Show when={s().files}>
            <span class="text-text-base">{s().files} files</span>
          </Show>
          <DiffChanges
            changes={{
              additions: s().additions ?? 0,
              deletions: s().deletions ?? 0,
            }}
          />
        </div>
      )}
    </Show>
  )
}
