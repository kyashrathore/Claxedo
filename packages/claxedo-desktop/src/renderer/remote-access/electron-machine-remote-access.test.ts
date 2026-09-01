import { describe, expect, test } from "bun:test"
import {
  electronMachineRemoteAccess,
  hostConnectorBridge,
  machineRemoteAccessStatus,
  type HostConnectorBridge,
  type HostConnectorSnapshot,
} from "./electron-machine-remote-access"

/**
 * The desktop-owned half of the port: the regression, and the constraints on
 * the fix.
 *
 * The regression is that "Enable remote access" performed an HTTP POST to
 * `/api/claxedo/remote-access/enable`, a path the desktop's sidecar
 * (`@claxedo/local-server`) does not serve. So every test that matters here
 * watches the TRANSPORT, not the return value.
 */

function bridge(snapshots: Partial<Record<keyof HostConnectorBridge, HostConnectorSnapshot>> = {}) {
  const calls: string[] = []
  const listeners: Array<(snapshot: HostConnectorSnapshot) => void> = []
  const answer = (name: "status" | "start" | "pause" | "revoke" | "share" | "unshare") => async () => {
    calls.push(name)
    return snapshots[name] ?? { status: "not-started", available: true, signedIn: true }
  }
  return {
    calls,
    push: (snapshot: HostConnectorSnapshot) => listeners.forEach((listener) => listener(snapshot)),
    handle: {
      status: answer("status"),
      start: answer("start"),
      pause: answer("pause"),
      revoke: answer("revoke"),
      share: answer("share"),
      unshare: answer("unshare"),
      onStatus: (listener: (snapshot: HostConnectorSnapshot) => void) => {
        listeners.push(listener)
        return () => listeners.splice(listeners.indexOf(listener), 1)
      },
    } satisfies HostConnectorBridge,
  }
}

const enrolled: HostConnectorSnapshot = { status: "enrolled", available: true, signedIn: true, expiresAt: 9_999 }

/**
 * A snapshot carrying more than the contract names.
 *
 * The index signature is what lets a test write the extra fields without a
 * cast, and a cast is exactly what would hide the thing being tested: whether
 * the port passes an unexpected field onward.
 */
type LeakySnapshot = HostConnectorSnapshot & Record<string, unknown>

describe("enabling remote access on the desktop", () => {
  test("reaches the connector by name and issues no request at all", async () => {
    // THE regression. Before the port, this call was
    // `fetch("/api/claxedo/remote-access/enable")` against a sidecar that
    // serves no such route. `fetch` is replaced for the duration so that a
    // reintroduced HTTP call fails loudly instead of 404-ing quietly.
    const connector = bridge({ start: enrolled })
    const requests: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (input: unknown) => {
      requests.push(String(input))
      throw new Error("the desktop has no remote-access route to call")
    }) as typeof fetch

    try {
      await electronMachineRemoteAccess(connector.handle).enable({ displayName: "Mac", startAtLogin: true })
    } finally {
      globalThis.fetch = original
    }

    expect(connector.calls).toEqual(["start"])
    expect(requests).toEqual([])
  })

  test("rejects when the machine did not end up published", async () => {
    // Resolving on a failed start is the shape that ships a broken feature
    // green: the panel would refetch, see nothing enrolled, and show no error.
    const connector = bridge({
      start: { status: "stopped", available: true, signedIn: true, reason: "error", detail: "control plane unreachable" },
    })

    await expect(electronMachineRemoteAccess(connector.handle).enable({ displayName: "Mac", startAtLogin: false }))
      .rejects.toThrow("control plane unreachable")
  })

  test("sends no label, no login preference and no request shape", async () => {
    // Every bridge member is zero-argument. Main signs the enrollment, so main
    // names the machine; a renderer that could choose the label is one step
    // from a renderer that can choose a route.
    const connector = bridge({ start: enrolled })
    const seen: unknown[][] = []
    const spy: HostConnectorBridge = {
      ...connector.handle,
      // Rest args, so the assertion sees whatever the port passed rather than
      // only the parameters the type happens to declare.
      start: async (...args: unknown[]) => {
        seen.push(args)
        return enrolled
      },
    }

    await electronMachineRemoteAccess(spy).enable({ displayName: "Yash's Mac", startAtLogin: true })

    expect(seen).toEqual([[]])
  })
})

describe("the closed operation set", () => {
  test("the bridge names exactly the six operations and a subscription", () => {
    // A member shaped `run(url, method, body)` is the confused deputy this
    // whole arrangement exists to prevent: main holds the account bearer and
    // a machine key that never expires. `share` is a named operation carrying
    // data only — a workspace id and a label — never a request description.
    const connector = bridge()

    expect(Object.keys(connector.handle).toSorted()).toEqual([
      "onStatus",
      "pause",
      "revoke",
      "share",
      "start",
      "status",
      "unshare",
    ])
  })

  test("refuses a bridge carrying a generic passthrough member", () => {
    // The detector, not just the absence: a preload that gained `run` would
    // still satisfy a shape check that only looks for the five it knows.
    const generic = {
      ...bridge().handle,
      run: async () => ({}),
    }

    expect(Object.keys(generic)).toContain("run")
    // `hostConnectorBridge` accepts it — it checks the members it needs — which
    // is exactly why the CLOSED set is enforced in main, where the credential
    // is, and asserted in `main/host-connector/ipc.test.ts`. Stated here so a
    // reader does not mistake this file for the control.
    expect(hostConnectorBridge({ api: { hostConnector: generic } })).toBeDefined()
  })

  test("reads no bridge from a browser build", () => {
    expect(hostConnectorBridge({})).toBeUndefined()
    expect(hostConnectorBridge({ api: {} })).toBeUndefined()
  })

  test("refuses a half-built bridge rather than failing at the button", () => {
    const partial = { status: () => {}, start: () => {}, pause: () => {} }

    expect(hostConnectorBridge({ api: { hostConnector: partial } })).toBeUndefined()
  })
})

describe("no credential crosses the bridge", () => {
  test("nothing the port returns carries a token, an id or key material", async () => {
    // Main holds the bearer and the machine key. The snapshot is a projection —
    // a status word, an expiry, a reason — and this asserts the port cannot
    // hand any of the rest onward even if a snapshot arrived carrying it.
    const leaky: LeakySnapshot = {
      ...enrolled,
      token: "sk-secret",
      refreshToken: "rt-secret",
      hostId: "host_secret",
    }
    const connector = bridge({ status: leaky, start: leaky, pause: leaky, revoke: leaky })
    const port = electronMachineRemoteAccess(connector.handle)

    const results = [
      await port.status(),
      await port.enable({ displayName: "Mac", startAtLogin: false }),
      await port.pause?.(),
      await port.revoke("host_secret"),
    ]

    const payload = JSON.stringify(results)
    for (const leaked of ["sk-secret", "rt-secret", "host_secret"]) {
      expect(payload, `must not carry ${leaked}`).not.toContain(leaked)
    }
  })
})

describe("status projection", () => {
  test("a live enrollment is both enrolled and enabled", () => {
    expect(machineRemoteAccessStatus(enrolled)).toEqual({
      deviceLoginConfigured: true,
      relayConfigured: true,
      hostedSignedIn: true,
      enrolled: true,
      enabled: true,
      secondDeviceOpen: false,
      // Main omits the field when the connector publishes nothing, and on this
      // product absent means empty rather than unknown — the connector always
      // knows what it serves.
      sharedWorkspaceIds: [],
    })
  })

  test("never reports enrolled-but-not-enabled, which is what auto-enables on launch", () => {
    // `remote-access-controller.ts` enables automatically when it sees
    // `enrolled && !enabled`. The desktop has no persisted enrollment to
    // remember, so no snapshot may produce that pair — otherwise a signed-in
    // launch would publish the user's laptop with nobody pressing anything.
    for (const status of ["not-started", "unavailable", "idle", "enrolled", "stopped"]) {
      const projected = machineRemoteAccessStatus({ status, available: true, signedIn: true })
      expect(projected.enrolled && !projected.enabled, `${status} must not auto-enable`).toBe(false)
    }
  })

  test("an unconfigured build reports a locked panel rather than an error", () => {
    expect(machineRemoteAccessStatus({ status: "not-started", available: false, signedIn: false })).toMatchObject({
      deviceLoginConfigured: false,
      relayConfigured: false,
      hostedSignedIn: false,
      enabled: false,
    })
  })
})

describe("capabilities this product does not have", () => {
  test("offers neither a second-device marker nor an account-wide device list", async () => {
    // `markSecondDeviceOpen` stays absent — the machine that published itself
    // is never the second device. `devices` stays absent too: enumerating the
    // account's machines is not one of the closed operations, and the
    // synthetic "this machine" row that used to stand in for it existed only
    // to carry `sharedWorkspaceIds` — which now travels on `status()`, its
    // authoritative producer.
    const idle = electronMachineRemoteAccess(bridge().handle)
    expect(idle.markSecondDeviceOpen).toBeUndefined()
    expect(idle.devices).toBeUndefined()
    expect(typeof idle.pause).toBe("function")
    expect(typeof idle.subscribe).toBe("function")
    expect(await idle.status()).toMatchObject({ enabled: false, sharedWorkspaceIds: [] })
  })

  test("status carries what this machine publishes, and nothing once it stops", async () => {
    const enrolled = electronMachineRemoteAccess(bridge({
      status: {
        status: "enrolled",
        available: true,
        signedIn: true,
        sharedWorkspaceIds: ["ws_local_1", "ws_local_2"],
      },
    }).handle)
    expect(await enrolled.status()).toMatchObject({
      enabled: true,
      sharedWorkspaceIds: ["ws_local_1", "ws_local_2"],
    })

    // A stopped connector publishes nothing, whatever a stale snapshot lists.
    const stopped = electronMachineRemoteAccess(bridge({
      status: {
        status: "stopped",
        available: true,
        signedIn: true,
        sharedWorkspaceIds: ["ws_local_1"],
      },
    }).handle)
    expect(await stopped.status()).toMatchObject({ enabled: false, sharedWorkspaceIds: [] })
  })

  test("revoking touches this machine, whatever id the caller names", async () => {
    const connector = bridge({ revoke: { status: "stopped", available: true, signedIn: true, reason: "revoked" } })

    await expect(electronMachineRemoteAccess(connector.handle).revoke("host_someone_else"))
      .resolves.toEqual({ revoked: true })
    // No argument reached main. Main's revoke takes none and can only destroy
    // the key on this disk.
    expect(connector.calls).toEqual(["revoke"])
  })
})

describe("pushed transitions", () => {
  test("a revocation nobody asked about reaches the subscriber", async () => {
    const connector = bridge()
    const seen: boolean[] = []
    const unsubscribe = electronMachineRemoteAccess(connector.handle).subscribe?.((status) => seen.push(status.enabled))

    connector.push(enrolled)
    connector.push({ status: "stopped", available: true, signedIn: true, reason: "revoked" })
    unsubscribe?.()
    connector.push(enrolled)

    expect(seen).toEqual([true, false])
  })
})
