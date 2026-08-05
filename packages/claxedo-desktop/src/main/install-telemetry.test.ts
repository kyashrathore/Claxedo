import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PostHog } from "posthog-node"
import { buildInstallProperties, reportInstall, resolveInstallId } from "./install-telemetry"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    // Restore write permission first — the read-only test below would
    // otherwise leave a directory rmSync cannot clean up.
    try {
      chmodSync(root, 0o755)
    } catch {
      // Already writable, or already gone.
    }
    rmSync(root, { recursive: true, force: true })
  }
})

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "install-telemetry-"))
  roots.push(root)
  return root
}

/** Records what a real PostHog client would have been asked to send. */
function fakeClient() {
  const captured: Array<{ distinctId: string; event: string; properties: Record<string, unknown> }> = []
  const client = {
    capture: (payload: { distinctId: string; event: string; properties: Record<string, unknown> }) => {
      captured.push(payload)
    },
    flush: () => Promise.resolve(),
  }
  return { client: client as unknown as PostHog, captured }
}

describe("resolveInstallId", () => {
  test("mints and persists an id on first run", () => {
    const dir = scratch()
    const first = resolveInstallId(dir)
    expect(first.firstRun).toBe(true)
    expect(first.installId).toMatch(/^[0-9a-f-]{36}$/)
    expect(readFileSync(join(dir, ".install-id-v1"), "utf8")).toBe(first.installId)
  })

  test("reuses the id and reports not-first on every later run", () => {
    const dir = scratch()
    const first = resolveInstallId(dir)
    const second = resolveInstallId(dir)
    expect(second.installId).toBe(first.installId)
    expect(second.firstRun).toBe(false)
  })

  test("a blank marker is still a used first run, not a re-report", () => {
    // An interrupted first write must not resurrect the event — re-reporting
    // an old install as new is worse than losing one id.
    const dir = scratch()
    writeFileSync(join(dir, ".install-id-v1"), "   ", "utf8")
    expect(resolveInstallId(dir).firstRun).toBe(true)
    expect(resolveInstallId(dir).firstRun).toBe(false)
  })
})

describe("reportInstall", () => {
  test("captures exactly one event on first run and none afterwards", async () => {
    const dir = scratch()
    const { client, captured } = fakeClient()
    const input = { userDataDir: dir, appVersion: "0.0.64", channel: "prod" }

    await reportInstall(client, input)
    expect(captured).toHaveLength(1)
    expect(captured[0]!.event).toBe("app_installed")

    await reportInstall(client, input)
    await reportInstall(client, input)
    expect(captured).toHaveLength(1)
  })

  test("distinct id is the install id, never a machine or user identifier", async () => {
    const dir = scratch()
    const { client, captured } = fakeClient()
    await reportInstall(client, { userDataDir: dir, appVersion: "0.0.64", channel: "prod" })
    const marker = readFileSync(join(dir, ".install-id-v1"), "utf8")
    expect(captured[0]!.distinctId).toBe(marker)
  })

  /**
   * PII-creep tripwire: the payload is asserted by EXACT key set, so adding a
   * property to buildInstallProperties fails here until someone looks at it.
   * An `includes`-style check would not bite.
   */
  test("sends exactly the allowlisted properties", async () => {
    const dir = scratch()
    const { client, captured } = fakeClient()
    await reportInstall(client, { userDataDir: dir, appVersion: "0.0.64", channel: "beta" })
    expect(Object.keys(captured[0]!.properties).sort()).toEqual([
      "app_version",
      "arch",
      "channel",
      "deployment_mode",
      "install_id",
      "os",
      "os_version",
      "unit",
    ])
    expect(captured[0]!.properties.channel).toBe("beta")
    expect(captured[0]!.properties.app_version).toBe("0.0.64")
    expect(captured[0]!.properties.deployment_mode).toBe("desktop-local")
  })

  test("no country or location is ever sent from the client", async () => {
    // PostHog derives an approximate country server-side from the request IP;
    // anything location-shaped leaving the client would be strictly worse.
    const dir = scratch()
    const { client, captured } = fakeClient()
    await reportInstall(client, { userDataDir: dir, appVersion: "0.0.64", channel: "prod" })
    const keys = Object.keys(captured[0]!.properties).join(" ")
    expect(keys).not.toMatch(/country|region|city|locale|timezone|tz|geo|ip/i)
  })

  test("a keyless build still consumes the first run", async () => {
    // Otherwise turning telemetry on later would report a months-old install
    // as brand new.
    const dir = scratch()
    await reportInstall(undefined, { userDataDir: dir, appVersion: "0.0.64", channel: "prod" })
    const { client, captured } = fakeClient()
    await reportInstall(client, { userDataDir: dir, appVersion: "0.0.64", channel: "prod" })
    expect(captured).toHaveLength(0)
  })

  test("a throwing client never propagates", async () => {
    const dir = scratch()
    const throwing = {
      capture: () => {
        throw new Error("posthog exploded")
      },
      flush: () => Promise.resolve(),
    } as unknown as PostHog
    expect(reportInstall(throwing, { userDataDir: dir, appVersion: "0.0.64", channel: "prod" })).resolves.toBeUndefined()
  })

  test("a rejecting flush never propagates", async () => {
    const dir = scratch()
    const rejecting = {
      capture: () => {},
      flush: () => Promise.reject(new Error("network down")),
    } as unknown as PostHog
    expect(reportInstall(rejecting, { userDataDir: dir, appVersion: "0.0.64", channel: "prod" })).resolves.toBeUndefined()
  })

  test("an unwritable userData directory never blocks startup", async () => {
    const dir = scratch()
    chmodSync(dir, 0o500)
    const { client } = fakeClient()
    expect(reportInstall(client, { userDataDir: join(dir, "nested"), appVersion: "0.0.64", channel: "prod" })).resolves.toBeUndefined()
  })

  test("a hung flush is bounded rather than awaited forever", async () => {
    const dir = scratch()
    const hanging = {
      capture: () => {},
      flush: () => new Promise<void>(() => {}),
    } as unknown as PostHog
    // Resolves via the timeout race, not the flush.
    expect(reportInstall(hanging, { userDataDir: dir, appVersion: "0.0.64", channel: "prod" }, 5)).resolves.toBeUndefined()
  })
})

describe("buildInstallProperties", () => {
  test("carries the running platform and architecture", () => {
    const properties = buildInstallProperties({ installId: "id", appVersion: "1.2.3", channel: "prod" })
    expect(properties.os).toBe(process.platform)
    expect(properties.arch).toBe(process.arch)
    expect(properties.os_version).toBeTruthy()
    expect(properties.unit).toBe("desktop-main")
  })
})
