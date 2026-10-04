import { onCleanup, type JSX, type ParentProps } from "solid-js"
import { useTranslator } from "@/i18n"
import { useSessionStores } from "@/session"
import { sessionPath, useShellRoute } from "@/shell"
import { ALERT_OF, type AlertKind, type AlertPreferences } from "./alerts"
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
  const stores = useSessionStores()
  const routing = useShellRoute()
  const sound = createSoundPlayer()
  const shownSession = () => {
    const route = routing.route()
    return route.kind === "session" || route.kind === "localSession" ? route.sessionId : undefined
  }
  onCleanup(
    stores.onAttention((attention) => {
      const alert = { kind: ALERT_OF[attention.kind], ref: attention.ref }
      const row = stores.list.view(alert.ref.sessionId)
      if (!row || row.parentSessionId) return
      if (shownSession() !== alert.ref.sessionId) sound.play(props.preferences.sound[alert.kind])
      if (!props.preferences.notify[alert.kind]) return
      showSystemNotification({
        title: t(TITLE[alert.kind]),
        body: row.title || t("notifications.sessionError.fallback"),
        onClick: () => routing.navigate(sessionPath(row.ref)),
      })
    }),
  )
  return props.children
}
