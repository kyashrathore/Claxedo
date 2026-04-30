import { createEffect, createMemo, on, onCleanup, type Accessor } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { Message, Part, PermissionRequest, QuestionRequest, Session, SessionStatus, Todo } from "@opencode-ai/sdk/v2/client"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import type { State } from "@/context/global-sync/types"
import { diffs as list, message as clean } from "@/utils/diffs"
import { idleSessionStatus, isSessionTurnActive, mergeBusySessionStatus, pickSessionPermissions, pickSessionQuestions } from "./session-store"
import {
  fetchSessionByTransport,
  fetchSessionMessagesByTransport,
  fetchSessionTodoByTransport,
  usesClaxedoSessionTransport,
} from "./session-transport"

function keyFor(directory: string, sessionID: string) {
  return `${directory}\n${sessionID}`
}

function runInflight(map: Map<string, Promise<boolean>>, key: string, task: () => Promise<boolean>) {
  const pending = map.get(key)
  if (pending) return pending
  const promise = task().finally(() => {
    map.delete(key)
  })
  map.set(key, promise)
  return promise
}

const metaInflight = new Map<string, Promise<boolean>>()
const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])

function mergeByID<T extends { id: string }>(existing: T[], next: T[]) {
  if (existing.length === 0) return next
  const map = new Map(existing.map((item) => [item.id, item] as const))
  next.forEach((item) => map.set(item.id, item))
  return [...map.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export function resolveStoredMessages<T extends { id: string }>(input: {
  existing: T[] | undefined
  next: T[]
  mode?: "replace" | "prepend"
}) {
  if (input.mode === "prepend") return mergeByID(input.existing ?? [], input.next)
  if (input.next.length > 0) return input.next
  if ((input.existing?.length ?? 0) === 0) return input.next
  return input.existing!
}

function storeSession(setStore: (fn: (draft: State) => void) => void, session: Session) {
  setStore(produce((draft: State) => {
    const index = draft.session.findIndex((item) => item.id === session.id)
    if (index !== -1) {
      draft.session[index] = session
      return
    }
    draft.session = mergeByID(draft.session, [session])
  }))
}

function storeMessages(input: {
  setStore: (fn: (draft: State) => void) => void
  sessionID: string
  rows: Array<{ info: Message; parts?: Part[] }>
  existing: Message[] | undefined
  mode?: "replace" | "prepend"
}) {
  const nextMessages = input.rows.map((row) => clean(row.info)).filter((item) => !!item?.id).sort((a, b) => a.id.localeCompare(b.id))
  input.setStore(produce((draft: State) => {
    draft.message[input.sessionID] = resolveStoredMessages({
      existing: input.existing,
      next: nextMessages,
      mode: input.mode,
    })

    input.rows.forEach((row) => {
      if (!row.info?.id) return
      const nextParts = (row.parts ?? []).filter((part) => !!part?.id && !SKIP_PARTS.has(part.type))
      if (nextParts.length === 0) return
      draft.part[row.info.id] = nextParts.sort((a, b) => a.id.localeCompare(b.id))
    })
  }))
}

function storeTodo(setStore: (fn: (draft: State) => void) => void, sessionID: string, todos: Todo[]) {
  setStore(produce((draft: State) => {
    draft.todo[sessionID] = todos
  }))
}

export function shouldHydrateSession(input: {
  sessionID?: string
  previousSessionID?: string
  healthy?: boolean
}) {
  const allowed = !!input.sessionID && input.sessionID !== "new" && input.healthy === true
  return allowed
}

export async function syncSessionMeta(input: {
  sessionID: string
  currentSessionID: Accessor<string | undefined>
  sdk: {
    session: {
      status: () => Promise<{ data?: Record<string, SessionStatus> }>
    }
    permission: {
      list: () => Promise<{ data?: PermissionRequest[] }>
    }
    question: {
      list: () => Promise<{ data?: QuestionRequest[] }>
    }
  }
  setStore: ((fn: (draft: State) => void) => void) | ((state: State | ((prev: State) => State)) => void)
}) {
  const [status, permissions, questions] = await Promise.all([
    input.sdk.session.status().then((x) => x.data ?? {}),
    input.sdk.permission.list().then((x) => x.data ?? []),
    input.sdk.question.list().then((x) => x.data ?? []),
  ])

  if (input.currentSessionID() !== input.sessionID) return false

  input.setStore(produce((draft: State) => {
    const server = status[input.sessionID]
    const sessionPermissions = pickSessionPermissions(permissions, input.sessionID)
    const sessionQuestions = pickSessionQuestions(questions, input.sessionID)
    const activeEvidence = isSessionTurnActive({
      permissions: sessionPermissions,
      questions: sessionQuestions,
    })
    const merged = mergeBusySessionStatus(draft.session_status[input.sessionID], server, activeEvidence)
    if (merged) draft.session_status[input.sessionID] = merged
    else delete draft.session_status[input.sessionID]
    draft.permission[input.sessionID] = sessionPermissions
    draft.question[input.sessionID] = sessionQuestions
  }))

  return true
}

export function createSessionController(input: {
  directory: Accessor<string>
  sessionID: Accessor<string | undefined>
  serverHealthy: Accessor<boolean | undefined>
}) {
  const sync = useSync()
  const sdk = useSDK()
  const setSync = sync.set as (fn: (draft: State) => void) => void
  const [compat, setCompat] = createStore({
    cursor: {} as Record<string, string | undefined>,
    complete: {} as Record<string, boolean>,
    loading: {} as Record<string, boolean>,
  })

  const info = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return
    return sync.session.get(sessionID) as Session | undefined
  })

  const messages = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return
    return sync.data.message[sessionID] as Message[] | undefined
  })

  const todos = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return []
    return sync.data.todo[sessionID] ?? []
  })

  const diffs = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return []
    return list(sync.data.session_diff[sessionID])
  })

  const status = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return idleSessionStatus
    return sync.data.session_status[sessionID] ?? idleSessionStatus
  })

  const permissionRequest = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return
    return sync.data.permission[sessionID]?.[0]
  })

  const questionRequest = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return
    return sync.data.question[sessionID]?.[0]
  })

  const blocked = createMemo(() => !!permissionRequest() || !!questionRequest())
  const usingCompat = createMemo(() => usesClaxedoSessionTransport(input.sessionID()))
  const activeTurn = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return false
    return isSessionTurnActive({
      status: sync.data.session_status[sessionID],
      permissions: sync.data.permission[sessionID],
      questions: sync.data.question[sessionID],
    })
  })

  const historyMore = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return false
    if (usingCompat()) {
      const key = keyFor(input.directory(), sessionID)
      return !!compat.cursor[key] && !compat.complete[key]
    }
    return sync.session.history.more(sessionID)
  })

  const historyLoading = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return false
    if (usingCompat()) return compat.loading[keyFor(input.directory(), sessionID)] ?? false
    return sync.session.history.loading(sessionID)
  })

  const syncCompatSession = async (sessionID: string, opts?: { force?: boolean; before?: string; mode?: "replace" | "prepend" }) => {
    const directory = input.directory()
    const key = keyFor(directory, sessionID)
    if (compat.loading[key]) {
      return false
    }
    const hasSession = !!sync.session.get(sessionID)
    const cached = sync.data.message[sessionID] !== undefined && compat.complete[key] !== undefined
    if (!opts?.before && hasSession && cached && !opts?.force) {
      return true
    }

    setCompat("loading", key, true)
    return Promise.all([
      !opts?.before && (!hasSession || opts?.force)
        ? fetchSessionByTransport({
            client: sdk.client.session,
            directory,
            sessionID,
          })
        : Promise.resolve(undefined),
      fetchSessionMessagesByTransport({
        client: sdk.client.session,
        directory,
        sessionID,
        limit: opts?.before ? 200 : 80,
        ...(opts?.before ? { before: opts.before } : {}),
      }),
    ])
      .then(([session, messages]) => {
        if (input.sessionID() !== sessionID) {
          return false
        }
        if (session?.data) storeSession(setSync, session.data)
        storeMessages({
          setStore: setSync,
          sessionID,
          existing: sync.data.message[sessionID],
          rows: messages.data ?? [],
          mode: opts?.mode,
        })
        const cursor = messages.response.headers.get("x-next-cursor") ?? undefined
        setCompat("cursor", key, cursor)
        setCompat("complete", key, !cursor)
        return true
      })
      .finally(() => {
        setCompat("loading", key, false)
      })
  }

  const syncCompatTodo = async (sessionID: string, opts?: { force?: boolean }) => {
    const cached = sync.data.todo[sessionID] !== undefined
    if (cached && !opts?.force) return true
    return fetchSessionTodoByTransport({
      client: sdk.client.session,
      directory: input.directory(),
      sessionID,
    }).then((todo) => {
      if (input.sessionID() !== sessionID) return false
      storeTodo(setSync, sessionID, todo.data ?? [])
      return true
    })
  }

  const refreshMeta = async (sessionID = input.sessionID(), opts?: { force?: boolean }) => {
    if (!sessionID || sessionID === "new") return false
    const cached =
      sync.data.session_status[sessionID] !== undefined &&
      sync.data.permission[sessionID] !== undefined &&
      sync.data.question[sessionID] !== undefined
    if (cached && !opts?.force) return true

    return runInflight(metaInflight, keyFor(input.directory(), sessionID), () =>
      syncSessionMeta({
        sessionID,
        currentSessionID: input.sessionID,
        sdk: sdk.client,
        setStore: setSync,
      }),
    )
  }

  createEffect(
    on(
      () => [input.directory(), input.sessionID(), input.serverHealthy()] as const,
      ([, sessionID, healthy], prev) => {
        const allowed = shouldHydrateSession({
          sessionID,
          previousSessionID: prev?.[1],
          healthy,
        })
        if (!allowed) return
        const id = sessionID
        if (!id) return
        if (usesClaxedoSessionTransport(id)) {
          void syncCompatSession(id)
          void syncCompatTodo(id)
          void refreshMeta(id)
          return
        }
        void sync.session.sync(id)
        void sync.session.todo(id)
        void refreshMeta(id)
      },
    ),
  )

  createEffect(
    on(
      () => [input.directory(), input.sessionID(), activeTurn(), input.serverHealthy()] as const,
      ([, sessionID, active, healthy]) => {
        if (!sessionID || sessionID === "new" || !active || healthy !== true) return
        const reconcile = () => {
          if (usesClaxedoSessionTransport(sessionID)) {
            void syncCompatSession(sessionID, { force: true })
            void syncCompatTodo(sessionID, { force: true })
          } else {
            void sync.session.sync(sessionID)
            void sync.session.todo(sessionID)
          }
          void refreshMeta(sessionID, { force: true })
        }
        reconcile()
        const timer = window.setInterval(reconcile, 2_000)
        onCleanup(() => window.clearInterval(timer))
      },
    ),
  )

  return {
    info,
    messages,
    todos,
    diffs,
    status,
    permissionRequest,
    questionRequest,
    blocked,
    activeTurn,
    historyMore,
    historyLoading,
    refreshMeta,
    loadMore: async (sessionID: string) => {
      if (!usesClaxedoSessionTransport(sessionID)) {
        await sync.session.history.loadMore(sessionID)
        return
      }
      const before = compat.cursor[keyFor(input.directory(), sessionID)]
      if (!before) return
      await syncCompatSession(sessionID, { before, mode: "prepend" })
    },
  }
}
