import { onCleanup, type JSX, type ParentProps } from "solid-js"
import { useTranslator } from "@/i18n"
import { useServer } from "@/server"
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

export function AttentionAlerts(props: ParentProps<{ readonly preferences: AlertPreferences }>): JSX.Element {
  const t = useTranslator(notificationsDictionary)
  const server = useServer()
  const routing = useShellRoute()
  const detect = createAlertDetector()
  const sound = createSoundPlayer()
  const shownSession = () => {
    const route = routing.route()
    return route.kind === "session" || route.kind === "localSession" ? route.sessionId : undefined
  }
  onCleanup(
    server.subscribe((event) => {
      const alert = detect(event)
      if (!alert) return
      if (shownSession() !== alert.ref.sessionId) {
        sound.play(props.preferences.sound[alert.kind])
      }
      if (!props.preferences.notify[alert.kind]) return
      showSystemNotification({
        title: t(TITLE[alert.kind]),
        body: alert.title || t("notifications.sessionError.fallback"),
        onClick: () => routing.navigate(sessionPath(alert.ref)),
      })
    }),
  )
  return props.children
}
