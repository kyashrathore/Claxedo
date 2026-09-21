import { createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { useQueries, useQuery } from "@tanstack/solid-query"
import type {
  AgentPermission as PermissionRequest,
  AgentPermissionReply,
  AgentQuestion as QuestionRequest,
  AgentTodo as Todo,
} from "@claxedo/agent-runtime-contract"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@/platform/i18n/provider"
import { usePermission } from "@/features/session/providers/permission"
import { useSDK } from "@/features/session/app-ports"
import { useSessionParams } from "@/features/session/providers/session-params"
import {
  directorySessionCacheQueryOptions,
  sessionRequestsCacheQueryOptions,
  sessionStatusCacheQueryOptions,
  sessionTodoCacheQueryOptions,
} from "@/features/session/data/sync/queries"
import { sessionQuestionRequest, sessionVisiblePermissionRequest } from "./session-request-tree"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"
import type { SessionRequestsQueryData } from "@/features/session/data/sync/queries"
import { permissionDecidedProperties } from "@/features/session/permission/modes"
import { capture as phCapture, identityProps } from "@/platform/telemetry/analytics"

// Long enough for the attach-time canonical meta read (scheduled ~1.5–2s after
// activation) plus transport latency to stamp `reconciledAt`; short enough that
// a session kind which never reconciles still surfaces a pending request.
const REQUEST_ATTACH_HOLD_MS = 6_000

// A completed list is the session's final task state — it stays mounted so the
// reader can reopen it after the turn ends, across reloads, and between rail
// visits. Only an unfinished list gates on `live`: pending rows on an idle
// session are leftovers from an interrupted turn, not state to surface.
export const todoState = (input: {
  count: number
  done: boolean
  live: boolean
}): "hide" | "open" => {
  if (input.count === 0) return "hide"
  if (input.done) return "open"
  if (!input.live) return "hide"
  return "open"
}

export function createSessionComposerState(options?: { active?: () => boolean; pendingSessionId?: () => string | undefined; pendingStartError?: () => string | undefined }) {
  const sessionParams = useSessionParams()
  const sdk = useSDK()
  const language = useLanguage()
  const permission = usePermission()
  createEffect(() => onCleanup(permission.observeDirectory(sdk.directory)))
  const activeSessionId = createMemo(() => {
    const id = options?.pendingSessionId?.() ?? sessionParams.sessionId()
    return !id || id === "new" ? "__claxedo_idle_session__" : id
  })
  const sessionsQuery = useQuery(() => directorySessionCacheQueryOptions({ directory: sdk.directory }))
  const sessionList = createMemo(() => sessionsQuery.data?.session ?? [])
  const statusQuery = useQuery(() => sessionStatusCacheQueryOptions({ sessionId: activeSessionId() }))
  const todoQuery = useQuery(() => sessionTodoCacheQueryOptions({ sessionId: activeSessionId() }))
  const sessionTreeIds = createMemo(() => {
    const id = options?.pendingSessionId?.() ?? sessionParams.sessionId()
    if (!id) return []
    const children = sessionList().reduce((acc, item) => {
      if (!item.parentID) return acc
      const list = acc.get(item.parentID)
      if (list) list.push(item.id)
      if (!list) acc.set(item.parentID, [item.id])
      return acc
    }, new Map<string, string[]>())
    const seen = new Set([id])
    const ids = [id]
    for (const current of ids) {
      for (const child of children.get(current) ?? []) {
        if (seen.has(child)) continue
        seen.add(child)
        ids.push(child)
      }
    }
    return ids
  })
  const requestQueries = useQueries(() => ({
    queries: sessionTreeIds().map((id) => sessionRequestsCacheQueryOptions({ sessionId: id })),
  }))
  // A request pending when this session attached is suspect: it may already be
  // resolved off-client, and retained replay redelivers its ask under the same
  // id. Hold those ids until the canonical directory read reconciles the entry
  // for this attach; requests asked while attached carry fresh ids and paint
  // immediately. The hold is bounded because some session kinds never produce
  // a canonical read — releasing degrades to the pre-gate behavior rather than
  // hiding a genuinely pending request forever.
  const [attachReleased, setAttachReleased] = createSignal(0)
  const paneVisible = options?.active ?? (() => true)
  const requestAttach = createMemo(() => {
    const visible = paneVisible()
    activeSessionId()
    const held = new Set<string>()
    if (visible) {
      // Untracked: the tree grows as a turn spawns children, and tracking it
      // would restart the hold on every session-list update — re-hiding
      // requests asked while attached for another six seconds.
      for (const treeId of untrack(sessionTreeIds)) {
        const data = queryClient.getQueryData<SessionRequestsQueryData>(shellDataKeys.sessionId(treeId, "requests"))
        for (const item of [...(data?.permissions ?? []), ...(data?.questions ?? [])]) held.add(item.id)
      }
    }
    const at = Date.now()
    const release = setTimeout(() => setAttachReleased(at), REQUEST_ATTACH_HOLD_MS)
    onCleanup(() => clearTimeout(release))
    return { at, held }
  })
  const requestRecords = createMemo(() => {
    const permissions: Record<string, PermissionRequest[] | undefined> = {}
    const questions: Record<string, QuestionRequest[] | undefined> = {}
    const attach = requestAttach()
    const released = attachReleased() === attach.at
    sessionTreeIds().forEach((id, index) => {
      const data = requestQueries[index]?.data
      if (!data) return
      const hold = <T extends { id: string }>(items: T[] | undefined) =>
        released || (data.reconciledAt !== undefined && data.reconciledAt >= attach.at)
          ? items
          : items?.filter((item) => !attach.held.has(item.id))
      permissions[id] = hold(data.permissions)
      questions[id] = hold(data.questions)
    })
    return { permissions, questions }
  })

  // The primary session owns this directory read and its Retry action. Child
  // panes reconcile their own cache entries through their session controller.
  const requestReadError = createMemo(() => options?.pendingStartError?.() ?? (Object.values(requestQueries[0]?.data?.readErrors ?? {}).filter(Boolean).join("\n") || undefined))

  const questionRequest = createMemo((): QuestionRequest | undefined => {
    return sessionQuestionRequest(sessionList(), requestRecords().questions, options?.pendingSessionId?.() ?? sessionParams.sessionId())
  })

  const permissionRequest = createMemo((): PermissionRequest | undefined => {
    return sessionVisiblePermissionRequest({
      ready: permission.requestPolicyReady(sdk.directory),
      sessions: sessionList(),
      requests: requestRecords().permissions,
      sessionID: sessionParams.sessionId(),
      include: (item) => !permission.autoResponds(item, sdk.directory),
    })
  })

  const blocked = createMemo(() => {
    const id = sessionParams.sessionId()
    if (!id) return false
    return !!permissionRequest() || !!questionRequest()
  })

  const todos = createMemo((): Todo[] => todoQuery.data ?? [])

  const done = createMemo(
    () => todos().length > 0 && todos().every((todo) => todo.status === "completed" || todo.status === "cancelled"),
  )

  const live = createMemo(() => ((statusQuery.data?.type ?? "idle") !== "idle") || blocked())

  const [store, setStore] = createStore({
    responding: undefined as string | undefined,
    dock: todos().length > 0 && (live() || done()),
  })

  const permissionResponding = createMemo(() => {
    const perm = permissionRequest()
    if (!perm) return false
    return store.responding === perm.id
  })

  const decide = (response: AgentPermissionReply) => {
    const perm = permissionRequest()
    if (!perm) return
    if (store.responding === perm.id) return

    // The dock's own Deny / Allow Always / Allow Once buttons — a human decided,
    // as opposed to the auto-accept path captured in `providers/permission.tsx`.
    if (typeof response === "string") phCapture("permission_decided", {
      ...identityProps(),
      surface: "session",
      ...permissionDecidedProperties({ response, toolKind: perm.permission, mode: "manual" }),
    })

    setStore("responding", perm.id)
    permission
      .respond({ sessionID: perm.sessionID, permissionID: perm.id, response, directory: sdk.directory })
      // Keep the accepted request locked until canonical query removal reaches
      // the observer; HTTP completion can precede the next reactive update.
      .catch((err: unknown) => {
        const description = err instanceof Error ? err.message : String(err)
        setStore("responding", (id) => (id === perm.id ? undefined : id))
        showToast({ title: language.t("common.requestFailed"), description })
      })
  }

  createEffect(
    on(
      () => [todos().length, done(), live()] as const,
      ([count, complete, active]) => {
        setStore("dock", todoState({ count, done: complete, live: active }) === "open")
      },
    ),
  )

  return {
    blocked,
    requestReadError,
    questionRequest,
    permissionRequest,
    permissionResponding,
    decide,
    todos,
    dock: () => store.dock,
  }
}

export type SessionComposerState = ReturnType<typeof createSessionComposerState>
