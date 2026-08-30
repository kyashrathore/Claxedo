import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AccountState } from "./account-service"
import {
  ACCOUNT_SIGN_IN_CHANNEL,
  ACCOUNT_STATE_CHANNEL,
  ACCOUNT_STREAM_OPEN_CHANNEL,
  ACCOUNT_STREAM_START_CHANNEL,
  type AccountIpcService,
  type AccountIpcTarget,
} from "./account-ipc"
import { setupLazyAccount } from "./lazy-account"
import { ACCOUNT_CREDENTIAL_RECORD } from "./marker"

function ipc() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handlers,
    target: {
      handle(channel, listener) {
        handlers.set(channel, listener as (...args: unknown[]) => unknown)
      },
    } satisfies AccountIpcTarget,
  }
}

function fixture(
  state: AccountState = { status: "unsigned" },
  openStream: AccountIpcService["openStream"] = async () => {},
) {
  const service = {
    state: () => state,
    signIn: async () => { state = { status: "pending" } },
    signOut: async () => { state = { status: "unsigned" } },
    run: async () => ({ ok: true }),
    openStream,
  }
  return { configured: true as const, service }
}

function sender() {
  const listeners = new Map<string, () => void>()
  const sent: Array<{ channel: string; payload: unknown }> = []
  return {
    sent,
    value: {
      once: (event: string, listener: () => void) => listeners.set(event, listener),
      removeListener: (event: string) => listeners.delete(event),
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    },
  }
}

async function flushStreamSettlement() {
  for (let index = 0; index < 10; index++) await Promise.resolve()
}

describe("setupLazyAccount", () => {
  test("does not load the account adapter for an unsigned profile state read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claxedo-lazy-account-"))
    try {
      const target = ipc()
      let loads = 0
      const account = setupLazyAccount({
        ipcMain: target.target,
        userDataDir: dir,
        load: async () => {
          loads++
          return { createAccountAssembly: () => fixture() }
        },
      })

      await account.ready
      expect(await target.handlers.get(ACCOUNT_STATE_CHANNEL)?.({})).toEqual({ status: "unsigned" })
      expect(loads).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("loads once when sign-in is explicitly requested", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claxedo-lazy-account-"))
    try {
      const target = ipc()
      let loads = 0
      setupLazyAccount({
        ipcMain: target.target,
        userDataDir: dir,
        load: async () => {
          loads++
          return { createAccountAssembly: () => fixture() }
        },
      })

      expect(await target.handlers.get(ACCOUNT_SIGN_IN_CHANNEL)?.({})).toEqual({ status: "pending" })
      expect(await target.handlers.get(ACCOUNT_SIGN_IN_CHANNEL)?.({})).toEqual({ status: "pending" })
      expect(loads).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("restores before ready when the nonsecret credential marker exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claxedo-lazy-account-"))
    try {
      writeFileSync(join(dir, ACCOUNT_CREDENTIAL_RECORD), "record")
      const target = ipc()
      let releaseAdapter!: () => void
      const adapterReady = new Promise<void>((resolve) => {
        releaseAdapter = resolve
      })
      let loads = 0
      const account = setupLazyAccount({
        ipcMain: target.target,
        userDataDir: dir,
        adapterReady,
        load: async () => ({
          createAccountAssembly: () => {
            loads++
            return fixture({ status: "signed", identity: { userId: "owner" } })
          },
        }),
      })

      await Promise.resolve()
      expect(loads).toBe(0)
      releaseAdapter()
      await account.ready
      expect(loads).toBe(1)
      expect(await target.handlers.get(ACCOUNT_STATE_CHANNEL)?.({})).toEqual({
        status: "signed",
        identity: { userId: "owner" },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("loads once and delegates a configured stream only after explicit start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claxedo-lazy-account-"))
    try {
      const target = ipc()
      const streamInputs: unknown[] = []
      let loads = 0
      setupLazyAccount({
        ipcMain: target.target,
        userDataDir: dir,
        load: async () => {
          loads++
          return {
            createAccountAssembly: () => fixture(
              { status: "signed", identity: { userId: "owner" } },
              async (input) => {
                streamInputs.push({ name: input.name, params: input.params })
                input.onChunk("ready")
              },
            ),
          }
        },
      })
      const streamSender = sender()

      const { streamId } = await target.handlers.get(ACCOUNT_STREAM_OPEN_CHANNEL)?.(
        { sender: streamSender.value },
        { operation: "session.events", input: { cursor: "12" } },
      ) as { streamId: string }
      expect(loads).toBe(0)

      await target.handlers.get(ACCOUNT_STREAM_START_CHANNEL)?.({ sender: streamSender.value }, { streamId })
      await flushStreamSettlement()

      expect(loads).toBe(1)
      expect(streamInputs).toEqual([{ name: "session.events", params: { cursor: "12" } }])
      expect(streamSender.sent.map((frame) => frame.channel)).toEqual([
        "claxedo.account.stream.chunk",
        "claxedo.account.stream.end",
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("loads an unavailable account stream and forwards its authoritative failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claxedo-lazy-account-"))
    try {
      const target = ipc()
      setupLazyAccount({
        ipcMain: target.target,
        userDataDir: dir,
        load: async () => ({
          createAccountAssembly: () => ({
            configured: false as const,
            missing: ["clientId"],
            service: fixture(
              { status: "unavailable", reason: "callback-failed" },
              async () => {
                throw new Error("this build has no account client configured")
              },
            ).service,
          }),
        }),
      })
      const streamSender = sender()
      const { streamId } = await target.handlers.get(ACCOUNT_STREAM_OPEN_CHANNEL)?.(
        { sender: streamSender.value },
        { operation: "session.events" },
      ) as { streamId: string }

      await target.handlers.get(ACCOUNT_STREAM_START_CHANNEL)?.({ sender: streamSender.value }, { streamId })
      await flushStreamSettlement()

      expect(streamSender.sent).toEqual([
        {
          channel: "claxedo.account.stream.error",
          payload: { streamId, message: "this build has no account client configured" },
        },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
