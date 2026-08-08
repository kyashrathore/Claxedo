import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  HOST_CONNECTOR_OPERATIONS,
  hostConnectorChannel,
  registerHostConnectorIpc,
  type HostConnectorIpcTarget,
} from "./ipc"
import { setupHostConnector, type HostConnectorSetup } from "./index"

/**
 * The trigger the Remote Access surface presses, and the two properties that
 * make it safe to expose at all.
 *
 * The regression this closes: "Enable remote access" performed
 * `POST /api/claxedo/remote-access/enable` over the desktop sidecar. That route
 * left the sidecar when machine publication moved to the Host Connector
 * (`local-product-contract.test.ts` freezes the five paths as host-connector's),
 * and nothing reconnected the button. So the tests below assert what the start
 * operation REACHES, not what it returns.
 */

function ipcMain() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    channels: () => [...handlers.keys()],
    /**
     * How many parameters each registered listener declares.
     *
     * The closed-set property made mechanical: a handler that reads the
     * message declares somewhere to put it. Zero everywhere means there is
     * nothing in an incoming message for any of them to act on.
     */
    arities: () => [...handlers.values()].map((listener) => listener.length),
    invoke: (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`no handler for ${channel}`)
      return handler({}, ...args)
    },
    target: {
      handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) {
        handlers.set(channel, listener)
      },
    } as unknown as HostConnectorIpcTarget,
  }
}

/** A `safeStorage` that really encrypts nothing but claims a real backend. */
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(plain),
  decryptString: (buffer: Buffer) => buffer.toString(),
  getSelectedStorageBackend: () => "gnome_libsecret",
}

/**
 * A real connector over a recording account runner.
 *
 * `setupHostConnector` is the production assembly — the real machine identity,
 * the real handshake, the real transport decoding. Only the account's `run` and
 * the timer are seams, which is what makes "the start operation reaches the
 * connector" a claim about the shipped path.
 */
function connectorHarness(input: { bearer?: string } = {}) {
  const operations: Array<{ name: string; params?: Record<string, unknown> }> = []
  const bearer = input.bearer ?? "bearer-do-not-leak"
  const enrollment = {
    enrollment_id: "enr_1",
    host_id: "host_1",
    expires_at: 1_000,
    // A control plane that echoed a credential back. It must not survive even
    // one layer: `accountConnectorTransport` decodes three named fields, and
    // the status projection drops what is left. Two narrowings, neither of
    // which is allowed to be the only one.
    token: bearer,
  }

  const connector = setupHostConnector({
    run: async (name, params) => {
      operations.push({ name, ...(params ? { params } : {}) })
      if (name === "host.enrollmentNonce") return { request_id: "req_1", nonce: "n_1", expires_at: 2_000, token: bearer }
      if (name === "host.enrollCurrentMachine") return { enrollment }
      if (name === "host.enrollmentHeartbeat") return { expires_at: 3_000 }
      throw new Error(`unexpected operation ${name}`)
    },
    safeStorage,
    userDataDir: mkdtempSync(path.join(tmpdir(), "claxedo-hc-ipc-")),
    platform: "darwin",
    displayName: "macOS",
    setInterval: () => ({ cancel: () => {} }),
  })

  return { connector, operations, bearer }
}

describe("start reaches the connector", () => {
  test("publishes the machine through the enrollment handshake, not a sidecar route", async () => {
    const ipc = ipcMain()
    const harness = connectorHarness()
    registerHostConnectorIpc({ ipcMain: ipc.target, connector: harness.connector, signedIn: () => true })

    const result = await ipc.invoke(hostConnectorChannel("start"))

    // The whole regression, stated as the operations the account actually
    // performed. Nothing here is `/api/claxedo/remote-access/enable`.
    expect(harness.operations.map((operation) => operation.name)).toEqual([
      "host.enrollmentNonce",
      "host.enrollCurrentMachine",
    ])
    expect(result).toMatchObject({ status: "enrolled", available: true, signedIn: true })
  })

  test("labels the machine from main, ignoring anything the message carries", async () => {
    const ipc = ipcMain()
    const harness = connectorHarness()
    registerHostConnectorIpc({ ipcMain: ipc.target, connector: harness.connector, signedIn: () => true })

    await ipc.invoke(hostConnectorChannel("start"), { displayName: "attacker-chosen", url: "https://evil.example" })

    const enroll = harness.operations.find((operation) => operation.name === "host.enrollCurrentMachine")
    expect(enroll?.params?.displayName).toBe("macOS")
  })

  test("refuses without a signed-in account instead of failing inside the handshake", async () => {
    const ipc = ipcMain()
    const harness = connectorHarness()
    registerHostConnectorIpc({ ipcMain: ipc.target, connector: harness.connector, signedIn: () => false })

    const result = await ipc.invoke(hostConnectorChannel("start"))

    expect(result).toMatchObject({ status: "stopped", detail: "Sign in to publish this machine" })
    // Not one call. A refusal that still asked the control plane would be a
    // 401 in the logs on every unsigned click.
    expect(harness.operations).toEqual([])
  })

  test("answers available:false rather than leaving the channel unregistered", async () => {
    // A build with no account client. An absent channel would leave
    // `window.api.hostConnector` half-built, the renderer would read the bridge
    // as missing, and the desktop would fall back to the HTTP implementation —
    // recreating the exact bug.
    const ipc = ipcMain()
    registerHostConnectorIpc({ ipcMain: ipc.target, signedIn: () => false })

    expect(ipc.channels().toSorted()).toEqual(HOST_CONNECTOR_OPERATIONS.map(hostConnectorChannel).toSorted())
    await expect(ipc.invoke(hostConnectorChannel("status"))).resolves.toMatchObject({ available: false })
    await expect(ipc.invoke(hostConnectorChannel("start"))).resolves.toMatchObject({
      status: "stopped",
      detail: "This build cannot publish a machine",
    })
  })
})

describe("the lifecycle behind the user's hand", () => {
  test("pause stops beating and keeps the identity; a later start re-enrols", async () => {
    const ipc = ipcMain()
    const harness = connectorHarness()
    registerHostConnectorIpc({ ipcMain: ipc.target, connector: harness.connector, signedIn: () => true })

    await ipc.invoke(hostConnectorChannel("start"))
    await expect(ipc.invoke(hostConnectorChannel("pause"))).resolves.toMatchObject({ status: "stopped" })
    await expect(ipc.invoke(hostConnectorChannel("start"))).resolves.toMatchObject({ status: "enrolled" })
  })

  test("revoke destroys the key, so the next start enrols a new machine", async () => {
    const ipc = ipcMain()
    const harness = connectorHarness()
    registerHostConnectorIpc({ ipcMain: ipc.target, connector: harness.connector, signedIn: () => true })

    await ipc.invoke(hostConnectorChannel("start"))
    const first = harness.operations.find((operation) => operation.name === "host.enrollCurrentMachine")?.params

    await expect(ipc.invoke(hostConnectorChannel("revoke"))).resolves.toMatchObject({
      status: "stopped",
      reason: "revoked",
    })
    await ipc.invoke(hostConnectorChannel("start"))
    const second = harness.operations.filter((operation) => operation.name === "host.enrollCurrentMachine")[1]?.params

    // A different host id AND a different public key. Same id with a new key
    // would look exactly like someone taking over this machine's identity.
    expect(second?.hostId).not.toBe(first?.hostId)
    expect(second?.publicKey).not.toBe(first?.publicKey)
  })

  test("nothing starts by being constructed", async () => {
    // The connector is built at launch and must publish nothing until asked.
    const ipc = ipcMain()
    const harness = connectorHarness()
    registerHostConnectorIpc({ ipcMain: ipc.target, connector: harness.connector, signedIn: () => true })

    await ipc.invoke(hostConnectorChannel("status"))

    expect(harness.operations).toEqual([])
  })
})

describe("the closed operation set", () => {
  test("registers exactly four channels, all under one prefix", () => {
    const ipc = ipcMain()
    registerHostConnectorIpc({ ipcMain: ipc.target, signedIn: () => true })

    expect(ipc.channels().toSorted()).toEqual([
      "claxedo.hostConnector.pause",
      "claxedo.hostConnector.revoke",
      "claxedo.hostConnector.start",
      "claxedo.hostConnector.status",
    ])
  })

  test("names no generic passthrough operation", () => {
    // The confused-deputy shape. Main holds the account bearer AND a machine
    // signing key that never expires, so a channel that could describe a
    // request would be strictly worse than the account's equivalent.
    for (const forbidden of ["fetch", "request", "proxy", "url", "invoke", "send", "run"]) {
      expect(
        HOST_CONNECTOR_OPERATIONS.filter((operation) => operation.toLowerCase().includes(forbidden)),
        `no operation may be a ${forbidden}`,
      ).toEqual([])
    }
  })

  test("every handler declares no parameter to receive a message into", () => {
    // The account's rule is that a renderer may supply reviewed PARAMETERS and
    // not a request. This surface is stricter and this is where that is
    // enforceable: a handler that read the message would have to declare
    // somewhere to put it. Non-zero here is the passthrough shape arriving.
    const ipc = ipcMain()
    registerHostConnectorIpc({ ipcMain: ipc.target, signedIn: () => true })

    expect(ipc.arities()).toEqual([0, 0, 0, 0])
  })

  test("no operation acts on anything the message carries", async () => {
    // Stronger than the account's rule, which substitutes reviewed parameters
    // into a fixed path. Here there is nothing to substitute: every handler is
    // invoked with a hostile payload and the connector performs the identical
    // work.
    const clean = ipcMain()
    const cleanHarness = connectorHarness()
    registerHostConnectorIpc({ ipcMain: clean.target, connector: cleanHarness.connector, signedIn: () => true })
    await clean.invoke(hostConnectorChannel("start"))

    const hostile = ipcMain()
    const hostileHarness = connectorHarness()
    registerHostConnectorIpc({ ipcMain: hostile.target, connector: hostileHarness.connector, signedIn: () => true })
    await hostile.invoke(hostConnectorChannel("start"), {
      url: "https://evil.example/api/admin",
      method: "DELETE",
      path: "/api/claxedo/host/enrollments",
      body: { hostId: "someone-else" },
      operation: "account.get",
    })

    const names = (operations: Array<{ name: string }>) => operations.map((operation) => operation.name)
    expect(names(hostileHarness.operations)).toEqual(names(cleanHarness.operations))
    expect(names(hostileHarness.operations)).toEqual(["host.enrollmentNonce", "host.enrollCurrentMachine"])
    // The hostile body did not reach the enrollment either.
    const enroll = hostileHarness.operations.find((operation) => operation.name === "host.enrollCurrentMachine")
    expect(enroll?.params?.hostId).not.toBe("someone-else")
  })

  test("the preload bridge names exactly these operations", () => {
    // The renderer's half of the closed set. A preload that grew a fifth member
    // would widen the surface without touching this directory, which is
    // precisely the change nobody would look for here.
    const preload = readFileSync(path.join(import.meta.dir, "../../preload/index.ts"), "utf8")
    const bridge = preload.slice(preload.indexOf("hostConnector: {"), preload.indexOf("account: {"))

    for (const operation of HOST_CONNECTOR_OPERATIONS) {
      expect(bridge, `preload must expose ${operation}`).toContain(`claxedo.hostConnector.${operation}`)
    }
    // Positive control: the slice is real, and the only other member is the
    // read-only push subscription.
    expect(bridge).toContain("onStatus")
    expect(bridge.match(/ipcRenderer\.invoke\(/g)?.length).toBe(HOST_CONNECTOR_OPERATIONS.length)
  })
})

describe("no credential crosses IPC", () => {
  test("no operation's result carries the account bearer or the machine key", async () => {
    const ipc = ipcMain()
    const bearer = "sk-account-bearer-must-not-leak"
    const harness = connectorHarness({ bearer })
    registerHostConnectorIpc({ ipcMain: ipc.target, connector: harness.connector, signedIn: () => true })

    const results = []
    for (const operation of HOST_CONNECTOR_OPERATIONS) {
      results.push(await ipc.invoke(hostConnectorChannel(operation)))
    }
    // Started, so a result exists that COULD carry an enrollment.
    results.push(await ipc.invoke(hostConnectorChannel("start")))

    const payload = JSON.stringify(results)
    for (const secret of [bearer, "enr_1", "host_1", "privateKey", "publicKey", "signature", "jwk"]) {
      expect(payload, `must not carry ${secret}`).not.toContain(secret)
    }
    // Positive control: the payload is not empty, so the assertions above are
    // not passing on nothing.
    expect(payload).toContain("enrolled")
  })
})

describe("wiring in the real entry", () => {
  const entry = readFileSync(path.join(import.meta.dir, "../index.ts"), "utf8")
  const code = entry
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*") && !line.trimStart().startsWith("/*"))
    .join("\n")

  test("registers these channels after the caller guard is installed", () => {
    // The guard works by wrapping `ipcMain.handle`; anything registered before
    // it keeps the unwrapped original and is permanently unguarded. These
    // channels drive a signing process, so an unguarded one would let any
    // webContents that reached the bridge publish the user's laptop.
    const installed = code.indexOf("installIpcCallerGuard({")
    const registered = code.indexOf("registerHostConnectorIpc({")

    expect(installed, "index.ts must install the guard").toBeGreaterThan(-1)
    expect(registered, "index.ts must register the host-connector channels").toBeGreaterThan(-1)
    expect(installed).toBeLessThan(registered)
  })

  test("still starts nothing at launch", () => {
    // The trigger now exists, so this matters more than it did: the ONLY caller
    // of `start()` must be the IPC operation the user's click reaches.
    expect(code).toContain("setupHostConnector({")
    expect(code).not.toMatch(/hostConnector[?.]*\.start\(/)
  })

  test("is the only module that registers them", () => {
    const files = (readdirSync(path.join(import.meta.dir, ".."), { recursive: true }) as string[])
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
      .filter((file) => existsSync(path.join(import.meta.dir, "..", file)))
      .filter((file) => readFileSync(path.join(import.meta.dir, "..", file), "utf8").includes("registerHostConnectorIpc({"))

    expect(files).toEqual(["index.ts"])
  })
})

describe("the connector's own lifecycle", () => {
  test("revoke leaves nothing on disk for a later launch to reuse", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "claxedo-hc-revoke-"))
    const connector: HostConnectorSetup = setupHostConnector({
      run: async (name) => {
        if (name === "host.enrollmentNonce") return { request_id: "r", nonce: "n", expires_at: 1 }
        if (name === "host.enrollCurrentMachine") {
          return { enrollment: { enrollment_id: "e", host_id: "h", expires_at: 1 } }
        }
        return {}
      },
      safeStorage,
      userDataDir: dir,
      platform: "darwin",
      setInterval: () => ({ cancel: () => {} }),
    })

    await connector.start()
    const identity = path.join(dir, "host-machine-identity.json")
    expect(existsSync(identity)).toBe(true)

    connector.revoke()

    expect(existsSync(identity)).toBe(false)
    expect(connector.status()).toMatchObject({ status: "stopped", reason: "revoked" })
  })

  test("pause announces the transition rather than changing state silently", () => {
    const seen: string[] = []
    const connector = setupHostConnector({
      run: async () => {
        throw new Error("offline")
      },
      safeStorage,
      userDataDir: mkdtempSync(path.join(tmpdir(), "claxedo-hc-pause-")),
      platform: "darwin",
      setInterval: () => ({ cancel: () => {} }),
      onStatusChange: (status) => seen.push(status.status),
    })

    connector.revoke()

    // The panel shows state the user did not cause; a stop that only assigned
    // would leave a revoked machine looking published until something else
    // happened to push.
    expect(seen).toEqual(["stopped"])
  })
})
