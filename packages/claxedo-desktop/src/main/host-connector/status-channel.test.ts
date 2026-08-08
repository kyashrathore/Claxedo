import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  HOST_CONNECTOR_STATUS_CHANNEL,
  publishHostConnectorStatus,
  toStatusEvent,
  type StatusTarget,
} from "./status-channel"
import type { HostConnectorStatus } from "./index"

/**
 * The status push, and the two things about it that are security decisions
 * rather than plumbing: what crosses the boundary, and what cannot be asked
 * for from the other side.
 */

function target() {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const state = {
    destroyed: false,
    sent,
    handle: {
      isDestroyed: () => state.destroyed,
      webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
    } satisfies StatusTarget,
  }
  return state
}

const enrolled = {
  status: "enrolled",
  enrollment: { enrollment_id: "enr_1", host_id: "host_1", expires_at: 9_999 },
} as unknown as HostConnectorStatus

describe("toStatusEvent", () => {
  test("projects the fields a panel renders, and no more", () => {
    // Not the state object. The connector's own shape carries an enrollment
    // record; sending it whole would put fields on the boundary that no
    // surface reads and every future reader would be tempted to.
    expect(toStatusEvent(enrolled)).toEqual({ status: "enrolled", expiresAt: 9_999 })
  })

  test("carries no enrollment id, host id or key material", () => {
    const payload = JSON.stringify(toStatusEvent(enrolled))

    for (const leaked of ["enr_1", "host_1", "publicKey", "privateKey", "signature"]) {
      expect(payload, `must not carry ${leaked}`).not.toContain(leaked)
    }
  })

  test("keeps the reason a stop carries, because the user sees it", () => {
    // "You paused this" and "your access was taken away" are different
    // messages, and the panel cannot tell them apart without the reason.
    const stopped = { status: "stopped", reason: "revoked", detail: "the server rejected this session" } as never

    expect(toStatusEvent(stopped)).toEqual({
      status: "stopped",
      reason: "revoked",
      detail: "the server rejected this session",
    })
  })

  test("omits absent fields rather than sending undefined", () => {
    expect(toStatusEvent({ status: "not-started" } as never)).toEqual({ status: "not-started" })
  })
})

describe("publishHostConnectorStatus", () => {
  test("sends on the one channel", () => {
    const window = target()

    expect(publishHostConnectorStatus(window.handle, enrolled)).toBe(true)
    expect(window.sent).toEqual([{ channel: HOST_CONNECTOR_STATUS_CHANNEL, payload: { status: "enrolled", expiresAt: 9_999 } }])
  })

  test("skips a destroyed window instead of throwing", () => {
    // This runs from a heartbeat timer. `send` on a destroyed webContents
    // throws, so an unchecked push turns a closed window into a repeating
    // crash in the main process rather than a no-op.
    const window = target()
    window.destroyed = true

    expect(publishHostConnectorStatus(window.handle, enrolled)).toBe(false)
    expect(window.sent).toEqual([])
  })

  test("skips an absent window", () => {
    expect(publishHostConnectorStatus(undefined, enrolled)).toBe(false)
  })
})

describe("the channel's direction", () => {
  test("registers nothing the renderer can call", () => {
    // Read-only by construction. Pausing or resuming is account-authorized and
    // belongs on the account's named operations, where the credential is; a
    // channel that let the renderer drive a signing process would be a second,
    // weaker path to the same authority.
    //
    // Scanned with comment lines stripped — the prose above explains the rule
    // and names the methods, so a raw-text scan would pass with a real
    // registration present.
    const code = readFileSync(path.join(import.meta.dir, "status-channel.ts"), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//") && !line.trimStart().startsWith("/*"))
      .join("\n")

    for (const forbidden of ["ipcMain", "handle(", "on(", "start(", "pause("]) {
      expect(code, `the status channel must not expose ${forbidden}`).not.toContain(forbidden)
    }
  })

  test("the scan is not vacuous", () => {
    // Positive control: every assertion above is "does not contain", which an
    // empty read also satisfies.
    const code = readFileSync(path.join(import.meta.dir, "status-channel.ts"), "utf8")

    expect(code).toContain("webContents.send")
    expect(code.length).toBeGreaterThan(500)
  })
})

describe("transitions reach the channel", () => {
  test("every state change is announced, not just polled", async () => {
    // The panel shows state the user did not cause, so a pull would only
    // update when it happened to ask. Driven through the real `setupHostConnector`
    // rather than a stub, because the property is that EVERY assignment goes
    // through the announcement — a future branch that sets state directly is
    // exactly what this catches.
    const { setupHostConnector } = await import("./index")
    const { mkdtempSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const path2 = await import("node:path")

    const seen: string[] = []
    const connector = setupHostConnector({
      run: async () => {
        throw new Error("control plane unreachable")
      },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (plain: string) => Buffer.from(plain),
        decryptString: (buf: Buffer) => buf.toString(),
        getSelectedStorageBackend: () => "gnome_libsecret",
      },
      userDataDir: mkdtempSync(path2.join(tmpdir(), "claxedo-status-")),
      platform: "darwin",
      setInterval: () => ({ cancel: () => {} }),
      onStatusChange: (status) => seen.push(status.status),
    })

    await connector.start()

    // A failed start is a transition the panel must see: it is the difference
    // between "enrolling" and "this machine is not connected".
    expect(seen).toContain("stopped")
  })
})
