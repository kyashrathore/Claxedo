import { expect, test } from "bun:test"
import { daemonStatusBridge, followDaemonStatus, readDaemonStatus, type DaemonStatusBridge } from "./daemon-status"

function fakeBridge(initial: unknown) {
  let listener: ((status: unknown) => void) | undefined
  let answer: (status: unknown) => void = () => undefined
  const relaunches: number[] = []
  const bridge: DaemonStatusBridge = {
    relaunch: () => relaunches.push(relaunches.length + 1),
    daemonStatus: {
      read: () => new Promise((resolve) => (answer = resolve)),
      onChange: (next) => {
        listener = next
        return () => (listener = undefined)
      },
    },
  }
  return {
    bridge,
    relaunches,
    answerRead: async () => {
      answer(initial)
      await Promise.resolve()
      await Promise.resolve()
    },
    push: (status: unknown) => listener?.(status),
    listening: () => listener !== undefined,
  }
}

test("daemon status: only a desktop preload with the whole bridge is followed", () => {
  expect(daemonStatusBridge(globalThis)).toBeUndefined()
  expect(daemonStatusBridge({ api: { relaunch: () => undefined } })).toBeUndefined()
  const api = { relaunch: () => undefined, daemonStatus: { read: async () => undefined, onChange: () => () => undefined } }
  expect(daemonStatusBridge({ api })).toBe(api)
})

test("daemon status: main's lost status keeps its restart and the exit that caused it", () => {
  expect(readDaemonStatus({ kind: "running" })).toEqual({ kind: "running" })
  expect(readDaemonStatus({ kind: "lost", restart: "relaunch" })).toEqual({ kind: "lost", restart: "relaunch" })
  expect(readDaemonStatus({ kind: "lost", restart: "reload", exit: { code: null, signal: "SIGKILL" } })).toEqual({
    kind: "lost",
    restart: "reload",
    exit: { code: null, signal: "SIGKILL" },
  })
})

test("daemon status: a status main pushed wins over an older read that answers after it", async () => {
  const fake = fakeBridge({ kind: "running" })
  const daemon = followDaemonStatus(fake.bridge)
  fake.push({ kind: "lost", restart: "relaunch" })
  await fake.answerRead()
  expect(daemon.status()).toEqual({ kind: "lost", restart: "relaunch" })
  daemon.stop()
  expect(fake.listening()).toBe(false)
})

test("daemon status: a window opened after the loss reads it", async () => {
  const fake = fakeBridge({ kind: "lost", restart: "relaunch", exit: { code: 1, signal: null } })
  const daemon = followDaemonStatus(fake.bridge)
  expect(daemon.status()).toEqual({ kind: "running" })
  await fake.answerRead()
  expect(daemon.status()).toEqual({ kind: "lost", restart: "relaunch", exit: { code: 1, signal: null } })
})

test("daemon status: restart relaunches once, and never while the daemon runs", async () => {
  const fake = fakeBridge({ kind: "running" })
  const daemon = followDaemonStatus(fake.bridge)
  await fake.answerRead()
  daemon.restart()
  expect(fake.relaunches).toEqual([])

  fake.push({ kind: "lost", restart: "relaunch" })
  daemon.restart()
  daemon.restart()
  expect(fake.relaunches).toEqual([1])
  expect(daemon.restarting()).toBe(true)
})
