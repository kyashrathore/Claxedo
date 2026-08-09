import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AccountState } from "./account-service"
import { ACCOUNT_SIGN_IN_CHANNEL, ACCOUNT_STATE_CHANNEL, type AccountIpcTarget } from "./account-ipc"
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

function fixture(state: AccountState = { status: "unsigned" }) {
  const service = {
    state: () => state,
    signIn: async () => { state = { status: "pending" } },
    signOut: async () => { state = { status: "unsigned" } },
    run: async () => ({ ok: true }),
  }
  return { configured: true as const, service }
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
})
