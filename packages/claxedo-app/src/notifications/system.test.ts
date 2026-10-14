/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createSystemNotificationPermission } from "./system"

const globals = globalThis as unknown as { window?: unknown; Notification?: unknown }
const saved = { window: globals.window, Notification: globals.Notification }

function browser(permission: NotificationPermission, answer: NotificationPermission) {
  const listeners = new Map<string, () => void>()
  const notification = {
    permission,
    requestPermission: async () => {
      notification.permission = answer
      return answer
    },
  }
  globals.Notification = notification
  globals.window = {
    Notification: notification,
    addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  }
  return { notification, focus: () => listeners.get("focus")?.(), listeners }
}

afterEach(() => {
  globals.window = saved.window
  globals.Notification = saved.Notification
})

test("system notifications: the permission signal reads the browser's answer, asks only while unasked, and rereads when the window regains focus", async () => {
  const page = browser("default", "granted")
  await createRoot(async (dispose) => {
    const permission = createSystemNotificationPermission()
    expect(permission.permission()).toBe("default")
    expect(await permission.request()).toBe("granted")
    expect(permission.permission()).toBe("granted")
    page.notification.permission = "denied"
    page.focus()
    expect(permission.permission()).toBe("denied")
    page.notification.requestPermission = async () => {
      throw new Error("a denied permission is never asked again")
    }
    expect(await permission.request()).toBe("denied")
    dispose()
    expect(page.listeners.size).toBe(0)
  })
})

test("system notifications: a browser without the Notification API reports it as unsupported", async () => {
  globals.Notification = undefined
  globals.window = { addEventListener: () => undefined, removeEventListener: () => undefined }
  await createRoot(async (dispose) => {
    const permission = createSystemNotificationPermission()
    expect(permission.permission()).toBe("unsupported")
    expect(await permission.request()).toBe("unsupported")
    dispose()
  })
})
