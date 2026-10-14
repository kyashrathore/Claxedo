import { createSignal, onCleanup, type Accessor } from "solid-js"

export type SystemNotificationPermission = NotificationPermission | "unsupported"

export type SystemNotificationAccess = {
  readonly permission: Accessor<SystemNotificationPermission>
  readonly request: () => Promise<SystemNotificationPermission>
}

export function systemNotificationsAvailable(): boolean {
  return typeof window !== "undefined" && "Notification" in window && window.Notification !== undefined
}

function currentPermission(): SystemNotificationPermission {
  return systemNotificationsAvailable() ? Notification.permission : "unsupported"
}

export function createSystemNotificationPermission(): SystemNotificationAccess {
  const [permission, setPermission] = createSignal(currentPermission())
  const reread = () => setPermission(currentPermission())
  if (typeof window !== "undefined") {
    window.addEventListener("focus", reread)
    onCleanup(() => window.removeEventListener("focus", reread))
  }
  return {
    permission,
    request: async () => {
      if (currentPermission() === "default") await Notification.requestPermission()
      reread()
      return permission()
    },
  }
}

export function showSystemNotification(input: { readonly title: string; readonly body: string; readonly onClick: () => void }): void {
  if (currentPermission() !== "granted") return
  if (document.visibilityState === "visible" && document.hasFocus()) return
  const notification = new Notification(input.title, { body: input.body, icon: "/favicon-96x96-v3.png" })
  notification.onclick = () => {
    window.focus()
    input.onClick()
    notification.close()
  }
}
