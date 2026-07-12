/**
 * Browser Notification-permission gating.
 *
 * Contract (see BUG A fix): the permission prompt is requested at most once,
 * and ONLY from an explicit user interaction — turning on a notification
 * toggle in Settings → General. Turn-completion (`platform.notify`, called
 * from session.idle/session.error handlers) must never call
 * `Notification.requestPermission()` itself; it only checks the CURRENT
 * `Notification.permission` and silently no-ops when it isn't "granted".
 *
 * Without this split, `platform.notify` re-requesting permission on every
 * turn (while permission stays "default" — e.g. the user never answered the
 * browser's prompt) reopens the OS/browser permission dialog on every single
 * turn completion.
 */

/** True whenever the browser exposes the Notification API at all. */
export function notificationApiAvailable(): boolean {
  return typeof window !== "undefined" && "Notification" in window
}

/**
 * Requests OS notification permission, but only if it is still undecided
 * ("default"). No-ops (and resolves with the current permission) once the
 * user has already granted or denied it — guaranteeing at most one real
 * browser prompt per permission-lifetime, regardless of how many times this
 * is called.
 *
 * Intended to be called ONLY from a direct user gesture (a Settings toggle
 * onChange handler) — never from background/event-driven code paths like
 * turn completion.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission | undefined> {
  if (!notificationApiAvailable()) return undefined
  if (Notification.permission !== "default") return Notification.permission
  return Notification.requestPermission().catch(() => "denied" as NotificationPermission)
}
