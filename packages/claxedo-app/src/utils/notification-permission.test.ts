import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { notificationApiAvailable, requestNotificationPermission } from "./notification-permission"

// Bug A: the browser's permission prompt was appearing on EVERY turn
// completion because `platform.notify` (src/main.tsx) called
// `Notification.requestPermission()` whenever `Notification.permission`
// was still "default" — which stays "default" forever if the user never
// answers the prompt, so it re-fired on every single call. These tests pin
// the fixed contract for the extracted helper: request at most once, and
// never touch the browser API once the user has decided.

type MockNotificationCtor = {
  permission: NotificationPermission
  requestPermission: () => Promise<NotificationPermission>
}

function installMockNotification(initialPermission: NotificationPermission, resolveTo: NotificationPermission) {
  let calls = 0
  const ctor: MockNotificationCtor = {
    permission: initialPermission,
    requestPermission: () => {
      calls += 1
      ctor.permission = resolveTo
      return Promise.resolve(resolveTo)
    },
  }
  ;(globalThis as Record<string, unknown>).Notification = ctor
  return {
    ctor,
    callCount: () => calls,
  }
}

describe("notificationApiAvailable", () => {
  const original = (globalThis as Record<string, unknown>).Notification

  afterEach(() => {
    ;(globalThis as Record<string, unknown>).Notification = original
  })

  test("false when the Notification global is absent", () => {
    delete (globalThis as Record<string, unknown>).Notification
    expect(notificationApiAvailable()).toBe(false)
  })

  test("true when the Notification global is present", () => {
    installMockNotification("default", "granted")
    expect(notificationApiAvailable()).toBe(true)
  })
})

describe("requestNotificationPermission", () => {
  const original = (globalThis as Record<string, unknown>).Notification

  afterEach(() => {
    ;(globalThis as Record<string, unknown>).Notification = original
  })

  test("requests the browser prompt exactly once when permission is undecided", async () => {
    const mock = installMockNotification("default", "granted")

    const result = await requestNotificationPermission()

    expect(result).toBe("granted")
    expect(mock.callCount()).toBe(1)
  })

  test("does not re-prompt on a second call once permission is decided", async () => {
    const mock = installMockNotification("default", "granted")

    await requestNotificationPermission()
    await requestNotificationPermission()
    await requestNotificationPermission()

    // The browser's real requestPermission() is only invoked once — every
    // later call short-circuits because permission is no longer "default".
    expect(mock.callCount()).toBe(1)
  })

  test("never calls requestPermission when already granted", async () => {
    const mock = installMockNotification("granted", "granted")

    const result = await requestNotificationPermission()

    expect(result).toBe("granted")
    expect(mock.callCount()).toBe(0)
  })

  test("never calls requestPermission when already denied", async () => {
    const mock = installMockNotification("denied", "granted")

    const result = await requestNotificationPermission()

    expect(result).toBe("denied")
    expect(mock.callCount()).toBe(0)
  })

  test("resolves undefined when the Notification API is unavailable", async () => {
    delete (globalThis as Record<string, unknown>).Notification

    const result = await requestNotificationPermission()

    expect(result).toBeUndefined()
  })

  test("falls back to denied when the browser prompt rejects", async () => {
    const ctor: MockNotificationCtor = {
      permission: "default",
      requestPermission: () => Promise.reject(new Error("dismissed")),
    }
    ;(globalThis as Record<string, unknown>).Notification = ctor

    const result = await requestNotificationPermission()

    expect(result).toBe("denied")
  })
})
