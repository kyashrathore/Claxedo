export function systemNotificationsAvailable(): boolean {
  return typeof window !== "undefined" && "Notification" in window
}

export async function requestSystemNotifications(): Promise<void> {
  if (!systemNotificationsAvailable() || Notification.permission !== "default") return
  await Notification.requestPermission()
}

export function showSystemNotification(input: { readonly title: string; readonly body: string; readonly onClick: () => void }): void {
  if (!systemNotificationsAvailable() || Notification.permission !== "granted") return
  if (document.visibilityState === "visible" && document.hasFocus()) return
  const notification = new Notification(input.title, { body: input.body, icon: "/favicon-96x96-v3.png" })
  notification.onclick = () => {
    window.focus()
    input.onClick()
    notification.close()
  }
}
