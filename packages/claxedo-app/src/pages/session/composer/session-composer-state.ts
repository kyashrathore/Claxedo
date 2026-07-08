import { createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useQueries, useQuery } from "@tanstack/solid-query"
import type { PermissionRequest, QuestionRequest, Todo } from "@opencode-ai/sdk/v2"
import { showToast } from "@opencode-ai/ui/toast"
import { useLanguage } from "@claxedo/context/language"
import { usePermission } from "@/context/permission"
import { useSDK } from "@/context/sdk"
import { useSessionParams } from "@claxedo/claxedo-ui/context/session-params"
import { queryClient } from "@claxedo/shared/query/query-client"
import {
  directorySessionCacheQueryOptions,
  sessionRequestsQueryOptions,
  sessionStatusQueryOptions,
  sessionTodoQueryOptions,
} from "@claxedo/shell/data/queries"
import { dispatchSessionTodoEvent } from "@/session/store/session-status-dispatcher"
import { sessionPermissionRequest, sessionQuestionRequest } from "./session-request-tree"

export const todoState = (input: {
  count: number
  done: boolean
  live: boolean
}): "hide" | "clear" | "open" | "close" => {
  if (input.count === 0) return "hide"
  if (!input.live) return "clear"
  if (!input.done) return "open"
  return "close"
}

export function createSessionComposerState(options?: { closeMs?: number | (() => number) }) {
  const sessionParams = useSessionParams()
  const sdk = useSDK()
  const language = useLanguage()
  const permission = usePermission()
  const activeSessionId = () => {
    const id = sessionParams.sessionId()
    return !id || id === "new" ? "__claxedo_idle_session__" : id
  }
  const sessionsQuery = useQuery(() => directorySessionCacheQueryOptions({ directory: sdk.directory }))
  const sessionList = createMemo(() => sessionsQuery.data?.session ?? [])
  const statusQuery = useQuery(() => ({
    ...sessionStatusQueryOptions({
      sessionId: activeSessionId(),
      client: sdk.client,
    }),
    enabled: false,
  }))
  const todoQuery = useQuery(() => {
    return {
      ...sessionTodoQueryOptions({
        sessionId: activeSessionId(),
        client: sdk.client,
      }),
      enabled: false,
    }
  })
  const sessionTreeIds = createMemo(() => {
    const id = sessionParams.sessionId()
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
    queries: sessionTreeIds().map((id) => ({
      ...sessionRequestsQueryOptions({ sessionId: id, client: sdk.client }),
      enabled: false,
    })),
  }))
  const requestRecords = createMemo(() => {
    const permissions: Record<string, PermissionRequest[] | undefined> = {}
    const questions: Record<string, QuestionRequest[] | undefined> = {}
    sessionTreeIds().forEach((id, index) => {
      const data = requestQueries[index]?.data
      if (!data) return
      permissions[id] = data.permissions
      questions[id] = data.questions
    })
    return { permissions, questions }
  })

  const questionRequest = createMemo((): QuestionRequest | undefined => {
    return sessionQuestionRequest(sessionList(), requestRecords().questions, sessionParams.sessionId())
  })

  const permissionRequest = createMemo((): PermissionRequest | undefined => {
    return sessionPermissionRequest(sessionList(), requestRecords().permissions, sessionParams.sessionId(), (item) => {
      return !permission.autoResponds(item, sdk.directory)
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
    dock: todos().length > 0 && live(),
    closing: false,
    opening: false,
  })

  const permissionResponding = createMemo(() => {
    const perm = permissionRequest()
    if (!perm) return false
    return store.responding === perm.id
  })

  const decide = (response: "once" | "always" | "reject") => {
    const perm = permissionRequest()
    if (!perm) return
    if (store.responding === perm.id) return

    setStore("responding", perm.id)
    permission
      .respond({ sessionID: perm.sessionID, permissionID: perm.id, response, directory: sdk.directory })
      .catch((err: unknown) => {
        const description = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description })
      })
      .finally(() => {
        setStore("responding", (id) => (id === perm.id ? undefined : id))
      })
  }

  let timer: number | undefined
  let raf: number | undefined

  const closeMs = () => {
    const value = options?.closeMs
    if (typeof value === "function") return Math.max(0, value())
    if (typeof value === "number") return Math.max(0, value)
    return 400
  }

  const scheduleClose = () => {
    if (timer) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      setStore({ dock: false, closing: false })
      timer = undefined
    }, closeMs())
  }

  const clear = () => {
    const id = sessionParams.sessionId()
    if (!id) return
    dispatchSessionTodoEvent({ event: { type: "session.todo", source: "optimistic", sessionID: id, todos: [] } })
  }

  createEffect(
    on(
      () => [todos().length, done(), live()] as const,
      ([count, complete, active]) => {
        if (raf) cancelAnimationFrame(raf)
        raf = undefined

        const next = todoState({
          count,
          done: complete,
          live: active,
        })

        if (next === "hide") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          setStore({ dock: false, closing: false, opening: false })
          return
        }

        if (next === "clear") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          clear()
          return
        }

        if (next === "open") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          const hidden = !store.dock || store.closing
          setStore({ dock: true, closing: false })
          if (hidden) {
            setStore("opening", true)
            raf = requestAnimationFrame(() => {
              setStore("opening", false)
              raf = undefined
            })
            return
          }
          setStore("opening", false)
          return
        }

        setStore({ dock: true, opening: false, closing: true })
        if (!timer) scheduleClose()
      },
    ),
  )

  onCleanup(() => {
    if (!timer) return
    window.clearTimeout(timer)
  })

  onCleanup(() => {
    if (!raf) return
    cancelAnimationFrame(raf)
  })

  return {
    blocked,
    questionRequest,
    permissionRequest,
    permissionResponding,
    decide,
    todos,
    dock: () => store.dock,
    closing: () => store.closing,
    opening: () => store.opening,
  }
}

export type SessionComposerState = ReturnType<typeof createSessionComposerState>
