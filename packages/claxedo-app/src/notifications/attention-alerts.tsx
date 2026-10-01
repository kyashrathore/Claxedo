import { createEffect, onCleanup, type JSX, type ParentProps } from "solid-js"
import { useTranslator } from "@/i18n"
import { useServer, type SessionId, type SessionLocation } from "@/server"
import { useSessionStores } from "@/session"
import { sessionPath, useShellRoute } from "@/shell"
import { createAlertDetector, type AlertKind, type AlertPreferences } from "./alerts"
import { notificationsDictionary, type NotificationKey } from "./i18n"
import { createSoundPlayer } from "./sounds"
import { showSystemNotification } from "./system"
import { createUnseenFailures, UnseenFailuresContext } from "./unseen-failures"

const TITLE: Readonly<Record<AlertKind, NotificationKey>> = {
  agent: "notifications.responseReady",
  permissions: "notifications.permission",
  errors: "notifications.sessionError",
}

export function AttentionAlerts(props: ParentProps<{ readonly preferences: AlertPreferences }>): JSX.Element {
  const t = useTranslator(notificationsDictionary)
  const server = useServer()
  const stores = useSessionStores()
  const routing = useShellRoute()
  const detect = createAlertDetector()
  const sound = createSoundPlayer()
  const unseen = createUnseenFailures()
  const shownSession = (): SessionId | undefined => {
    const route = routing.route()
    return route.kind === "session" || route.kind === "localSession" ? route.sessionId : undefined
  }
  const shown = (ref: SessionLocation) => shownSession() === ref.sessionId
  createEffect(() => {
    const sessionId = shownSession()
    if (sessionId) unseen.seen(sessionId)
  })
  onCleanup(
    server.subscribe((event) => {
      const alert = detect(event)
      if (!alert) return
      const row = stores.list.view(alert.ref.sessionId)
      if (!row || row.parentSessionId) return
      if (!shown(alert.ref)) {
        sound.play(props.preferences.sound[alert.kind])
        if (alert.kind === "errors") unseen.raised(alert.ref.sessionId)
      }
      if (!props.preferences.notify[alert.kind]) return
      showSystemNotification({
        title: t(TITLE[alert.kind]),
        body: row.title || t("notifications.sessionError.fallback"),
        onClick: () => routing.navigate(sessionPath(row.ref)),
      })
    }),
  )
  return <UnseenFailuresContext.Provider value={unseen}>{props.children}</UnseenFailuresContext.Provider>
}
