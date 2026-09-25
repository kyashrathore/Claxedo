import { onCleanup } from "solid-js"
import { useTranslator } from "@/i18n"
import { useServer, type SessionRef } from "@/server"
import { useSessionStores } from "@/session"
import { sessionPath, useShellRoute } from "@/shell"
import { createAlertDetector, type AlertKind, type AlertPreferences } from "./alerts"
import { notificationsDictionary, type NotificationKey } from "./i18n"
import { createSoundPlayer } from "./sounds"
import { showSystemNotification } from "./system"

const TITLE: Readonly<Record<AlertKind, NotificationKey>> = {
  agent: "notifications.responseReady",
  permissions: "notifications.permission",
  errors: "notifications.sessionError",
}

export function AttentionAlerts(props: { readonly preferences: AlertPreferences }) {
  const t = useTranslator(notificationsDictionary)
  const server = useServer()
  const stores = useSessionStores()
  const routing = useShellRoute()
  const detect = createAlertDetector()
  const sound = createSoundPlayer()
  const shown = (ref: SessionRef) => {
    const route = routing.route()
    return (route.kind === "session" || route.kind === "localSession") && route.sessionId === ref.sessionId
  }
  onCleanup(
    server.subscribe((event) => {
      const alert = detect(event)
      if (!alert) return
      const row = stores.list.rows().find((candidate) => candidate.ref.sessionId === alert.ref.sessionId)
      if (!row || row.parentSessionId) return
      if (!shown(alert.ref)) sound.play(props.preferences.sound[alert.kind])
      if (!props.preferences.notify[alert.kind]) return
      showSystemNotification({
        title: t(TITLE[alert.kind]),
        body: row.title || t("notifications.sessionError.fallback"),
        onClick: () => routing.navigate(sessionPath(row.ref)),
      })
    }),
  )
  return null
}
