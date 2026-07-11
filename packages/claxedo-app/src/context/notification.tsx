/**
 * Claxedo notification context.
 *
 * Removes direct sound calls from session.idle and session.error handlers.
 * Sound notifications are now handled centrally by the agent lifecycle hooks
 * (`useSessionStatusListener` in claxedo-ui/state/agent-status-listener.ts), which only play sound
 * when the session tab is not active — matching the behavior of terminal CLI agents.
 *
 * Everything else (notification list, OS notifications, persistence) is preserved.
 */

import { createStore, reconcile } from "solid-js/store"
import { batch, createEffect, createSignal, onCleanup } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { EventSessionError } from "@opencode-ai/sdk/v2"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { Persist, persisted } from "@/utils/persist"
import { sessionRoute, workspaceRoute } from "../shell/identity/route"
import { directorySessions, upsertDirectorySession } from "../shell/data/directory-session-cache"

type NotificationBase = {
  directory?: string
  session?: string
  metadata?: unknown
  time: number
  viewed: boolean
}

type TurnCompleteNotification = NotificationBase & {
  type: "turn-complete"
}

type ErrorNotification = NotificationBase & {
  type: "error"
  error: EventSessionError["properties"]["error"]
}

export type Notification = TurnCompleteNotification | ErrorNotification

type NotificationIndex = {
  session: {
    all: Record<string, Notification[]>
    unseen: Record<string, Notification[]>
    unseenCount: Record<string, number>
    unseenHasError: Record<string, boolean>
  }
  project: {
    all: Record<string, Notification[]>
    unseen: Record<string, Notification[]>
    unseenCount: Record<string, number>
    unseenHasError: Record<string, boolean>
  }
}

const MAX_NOTIFICATIONS = 500
const NOTIFICATION_TTL_MS = 1000 * 60 * 60 * 24 * 30

export function notificationViewedByScope(input: {
  eventDirectory: string
  sessionID?: string
  active: { directory?: string; session?: string }
}) {
  if (!input.active.directory) return false
  if (!input.active.session) return false
  if (!input.sessionID) return false
  if (input.eventDirectory !== input.active.directory) return false
  return input.sessionID === input.active.session
}

export async function lookupNotificationSession(input: {
  directory: Session["directory"]
  sessionID: string
  getSession: (parameters: { directory: Session["directory"]; sessionID: string }) => Promise<Session | undefined>
}) {
  const cached = directorySessions(input.directory).find((item) => item.id === input.sessionID)
  if (cached) return cached

  const session = await input.getSession({
    directory: input.directory,
    sessionID: input.sessionID,
  }).catch(() => undefined)
  if (!session) return undefined

  upsertDirectorySession(input.directory, session)
  return session
}

function pruneNotifications(list: Notification[]) {
  const cutoff = Date.now() - NOTIFICATION_TTL_MS
  const pruned = list.filter((n) => n.time >= cutoff)
  if (pruned.length <= MAX_NOTIFICATIONS) return pruned
  return pruned.slice(pruned.length - MAX_NOTIFICATIONS)
}

function buildNotificationIndex(list: Notification[]): NotificationIndex {
  const index: NotificationIndex = {
    session: {
      all: {},
      unseen: {},
      unseenCount: {},
      unseenHasError: {},
    },
    project: {
      all: {},
      unseen: {},
      unseenCount: {},
      unseenHasError: {},
    },
  }

  list.forEach((notification) => {
    if (notification.session) {
      const all = index.session.all[notification.session] ?? []
      index.session.all[notification.session] = [...all, notification]
      if (!notification.viewed) {
        const unseen = index.session.unseen[notification.session] ?? []
        index.session.unseen[notification.session] = [...unseen, notification]
        index.session.unseenCount[notification.session] = unseen.length + 1
        if (notification.type === "error") index.session.unseenHasError[notification.session] = true
      }
    }

    if (notification.directory) {
      const all = index.project.all[notification.directory] ?? []
      index.project.all[notification.directory] = [...all, notification]
      if (!notification.viewed) {
        const unseen = index.project.unseen[notification.directory] ?? []
        index.project.unseen[notification.directory] = [...unseen, notification]
        index.project.unseenCount[notification.directory] = unseen.length + 1
        if (notification.type === "error") index.project.unseenHasError[notification.directory] = true
      }
    }
  })

  return index
}

const notificationContextInput = {
  name: "Notification", gate: true,
  init: () => {
    const globalSDK = useGlobalSDK()
    const platform = usePlatform()
    const settings = useSettings()
    const language = useLanguage()

    const empty: Notification[] = []
    const [activeScope, setActiveScope] = createSignal<{ directory?: string; session?: string }>({})

    const [store, setStore, _, ready] = persisted(
      Persist.global("notification", ["notification.v1"]),
      createStore({
        list: [] as Notification[],
      }),
    )
    const [index, setIndex] = createStore<NotificationIndex>(buildNotificationIndex(store.list))

    const meta = { pruned: false, disposed: false }

    const updateUnseen = (scope: "session" | "project", key: string, unseen: Notification[]) => {
      setIndex(scope, "unseen", key, unseen)
      setIndex(scope, "unseenCount", key, unseen.length)
      setIndex(
        scope,
        "unseenHasError",
        key,
        unseen.some((notification) => notification.type === "error"),
      )
    }

    const appendToIndex = (notification: Notification) => {
      if (notification.session) {
        setIndex("session", "all", notification.session, (all = []) => [...all, notification])
        if (!notification.viewed) {
          setIndex("session", "unseen", notification.session, (unseen = []) => [...unseen, notification])
          setIndex("session", "unseenCount", notification.session, (count = 0) => count + 1)
          if (notification.type === "error") setIndex("session", "unseenHasError", notification.session, true)
        }
      }

      if (notification.directory) {
        setIndex("project", "all", notification.directory, (all = []) => [...all, notification])
        if (!notification.viewed) {
          setIndex("project", "unseen", notification.directory, (unseen = []) => [...unseen, notification])
          setIndex("project", "unseenCount", notification.directory, (count = 0) => count + 1)
          if (notification.type === "error") setIndex("project", "unseenHasError", notification.directory, true)
        }
      }
    }

    const removeFromIndex = (notification: Notification) => {
      if (notification.session) {
        setIndex("session", "all", notification.session, (all = []) => all.filter((n) => n !== notification))
        if (!notification.viewed) {
          const unseen = (index.session.unseen[notification.session] ?? empty).filter((n) => n !== notification)
          updateUnseen("session", notification.session, unseen)
        }
      }

      if (notification.directory) {
        setIndex("project", "all", notification.directory, (all = []) => all.filter((n) => n !== notification))
        if (!notification.viewed) {
          const unseen = (index.project.unseen[notification.directory] ?? empty).filter((n) => n !== notification)
          updateUnseen("project", notification.directory, unseen)
        }
      }
    }

    createEffect(() => {
      if (!ready()) return
      if (meta.pruned) return
      meta.pruned = true
      const list = pruneNotifications(store.list)
      batch(() => {
        setStore("list", list)
        setIndex(reconcile(buildNotificationIndex(list), { merge: false }))
      })
    })

    const append = (notification: Notification) => {
      const list = pruneNotifications([...store.list, notification])
      const keep = new Set(list)
      const removed = store.list.filter((n) => !keep.has(n))

      batch(() => {
        if (keep.has(notification)) appendToIndex(notification)
        removed.forEach((n) => removeFromIndex(n))
        setStore("list", list)
      })
    }

    const unsub = globalSDK.event.listen((e) => {
      if (meta.disposed) return
      const event = e.details
      if (event.type !== "session.idle" && event.type !== "session.error") return

      const directory = e.name
      const time = Date.now()
      const viewed = (sessionID?: string) => {
        return notificationViewedByScope({
          eventDirectory: directory,
          sessionID,
          active: activeScope(),
        })
      }
      switch (event.type) {
        case "session.idle": {
          const sessionID = event.properties.sessionID
          void lookupNotificationSession({
            directory,
            sessionID,
            getSession: (parameters) => globalSDK.client.session.get(parameters).then((result) => result.data),
          }).then((session) => {
            if (meta.disposed || !session || session.parentID) return

            // Sound is handled by useSessionStatusListener — not here

            append({
              directory,
              time,
              viewed: viewed(sessionID),
              type: "turn-complete",
              session: sessionID,
            })

            const href = sessionRoute(sessionID)
            if (settings.notifications.agent()) {
              void platform.notify(
                language.t("notification.session.responseReady.title"),
                session.title,
                href,
              )
            }
          })
          break
        }
        case "session.error": {
          const sessionID = event.properties.sessionID
          const notifyError = (session?: Session) => {
            if (meta.disposed || session?.parentID) return

            // Sound is handled by useSessionStatusListener — not here

            const error = "error" in event.properties ? event.properties.error : undefined
            append({
              directory,
              time,
              viewed: viewed(sessionID),
              type: "error",
              session: sessionID ?? "global",
              error,
            })
            const description =
              session?.title ??
              (typeof error === "string" ? error : language.t("notification.session.error.fallbackDescription"))
            const href = sessionID ? sessionRoute(sessionID) : workspaceRoute(directory)
            if (settings.notifications.errors()) {
              void platform.notify(language.t("notification.session.error.title"), description, href)
            }
          }
          if (!sessionID) {
            notifyError()
            break
          }
          void lookupNotificationSession({
            directory,
            sessionID,
            getSession: (parameters) => globalSDK.client.session.get(parameters).then((result) => result.data),
          }).then((session) => {
            if (!session) return
            notifyError(session)
          })
          break
        }
      }
    })
    onCleanup(() => {
      meta.disposed = true
      unsub()
    })

    return {
      ready,
      setActiveScope(input: { directory?: string; session?: string }) {
        setActiveScope(input)
      },
      session: {
        all(session: string) {
          return index.session.all[session] ?? empty
        },
        unseen(session: string) {
          return index.session.unseen[session] ?? empty
        },
        unseenCount(session: string) {
          return index.session.unseenCount[session] ?? 0
        },
        unseenHasError(session: string) {
          return index.session.unseenHasError[session] ?? false
        },
        markViewed(session: string) {
          const unseen = index.session.unseen[session] ?? empty
          if (!unseen.length) return

          const projects = [
            ...new Set(unseen.flatMap((notification) => (notification.directory ? [notification.directory] : []))),
          ]
          batch(() => {
            setStore("list", (n) => n.session === session && !n.viewed, "viewed", true)
            updateUnseen("session", session, [])
            projects.forEach((directory) => {
              const next = (index.project.unseen[directory] ?? empty).filter(
                (notification) => notification.session !== session,
              )
              updateUnseen("project", directory, next)
            })
          })
        },
      },
      project: {
        all(directory: string) {
          return index.project.all[directory] ?? empty
        },
        unseen(directory: string) {
          return index.project.unseen[directory] ?? empty
        },
        unseenCount(directory: string) {
          return index.project.unseenCount[directory] ?? 0
        },
        unseenHasError(directory: string) {
          return index.project.unseenHasError[directory] ?? false
        },
        markViewed(directory: string) {
          const unseen = index.project.unseen[directory] ?? empty
          if (!unseen.length) return

          const sessions = [
            ...new Set(unseen.flatMap((notification) => (notification.session ? [notification.session] : []))),
          ]
          batch(() => {
            setStore("list", (n) => n.directory === directory && !n.viewed, "viewed", true)
            updateUnseen("project", directory, [])
            sessions.forEach((session) => {
              const next = (index.session.unseen[session] ?? empty).filter(
                (notification) => notification.directory !== directory,
              )
              updateUnseen("session", session, next)
            })
          })
        },
      },
    }
  },
}
export const { use: useNotification, provider: NotificationProvider } = createSimpleContext<ReturnType<typeof notificationContextInput.init>, Record<string, any>>(notificationContextInput)
