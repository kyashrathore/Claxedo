import { expect, test } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import type { SandboxDriver, SandboxPersistenceCapabilities } from "@claxedo/sandbox-manager"
import { createMemoryLeaseStore } from "@claxedo/sandbox-manager/stores/memory"
import { composeProviderNeutralHostedControlPlane } from "./provider-neutral-hosted-services"
import { hostedWorkspaceIdleStop } from "../workspace/routes/checkpoints"
import { unusedSandboxStarts } from "../test-support/inline-sandbox-start"

const SUSPENDS: SandboxPersistenceCapabilities = { resume: "same-sandbox", capture: "none", clone: false, captureSource: "not-applicable", retention: "not-applicable", restoreMount: "not-applicable" }
const CAPTURES_TO_NEW_RESOURCE: SandboxPersistenceCapabilities = { resume: "replacement-restore", capture: "filesystem", clone: false, captureSource: "preserved", retention: "explicit", restoreMount: "new-resource" }

function scriptedDriver(input: { persistence?: SandboxPersistenceCapabilities; host?: () => "serving" | "stopped" | "gone" } = {}): SandboxDriver {
  const host = input.host
  return {
    id: "test",
    metadata: {
      driverRunsIn: ["node"], hostStopBehavior: "suspends-host", hostResumeBehavior: "same-host", targetAccess: "relay", secretBrokering: "none", egressControl: "hosts-and-cidrs",
      persistence: input.persistence ?? SUSPENDS,
    },
    ensureHost: async (ensure) => ({ sandboxId: `sb_${ensure.workspaceId}`, url: "https://sandbox.test", hostId: `host_${ensure.workspaceId}`, labels: ensure.labels }),
    ...(host ? { inspect: async () => host() } : {}),
  }
}

async function composedPlane(driver: SandboxDriver) {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  const notices: Array<{ workspaceId: string; step: string }> = []
  const orgKey = { id: "cred_boat", owner: null, provider_id: "boat", kind: "sandbox_driver", status: "active", revision: 1, created_at: 1 }
  const { services } = composeProviderNeutralHostedControlPlane({
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
    CLAXEDO_WORKSPACE_RELAY_URL: "https://relay.claxedo.test",
    CLAXEDO_RELAY_RESOLVER_TOKEN: "relay-resolver-secret",
  }, {
    auth: { config: { enabled: true, mode: "signed" } } as never,
    authority: { resolveWorkspaceOwner: async () => ({ userId: "usr_owner", orgId: "org_1" }) } as never,
    hostTunnelResolver: (async () => undefined) as never,
    orgCredentials: () => ({
      listCredentials: async () => [orgKey],
      resolveCredentialSecretById: async () => JSON.stringify({ api_key: "bx" }),
    }) as never,
    sandbox: {
      leaseStore: createMemoryLeaseStore(),
      keys: { drivers: ["boat"], create: () => driver, chosenDriver: async () => undefined },
      ...unusedSandboxStarts,
      announce: async (workspaceId, step) => {
        notices.push({ workspaceId, step })
      },
    },
  })
  const manager = services.sandbox.sandboxManager
  if (!manager) throw new Error("the plane composed no sandbox manager")
  const ready = async (workspaceId: string) => {
    const started = await manager.ensure(workspaceId, { homeRegion: "us-east", labels: {} })
    if (started.status !== "ready") throw new Error(`the sandbox did not start: ${JSON.stringify(started)}`)
    return started.epoch
  }
  return { services, manager, notices, ready }
}

test("a person's Stop and an idle stop each tell the workspace owner's open clients once that the machine is asleep", async () => {
  const plane = await composedPlane(scriptedDriver())
  await plane.ready("ws_person")
  expect((await plane.manager.stop("ws_person")).ok).toBe(true)
  expect(plane.notices).toEqual([{ workspaceId: "ws_person", step: "stopped" }])

  const epoch = await plane.ready("ws_idle")
  expect((await hostedWorkspaceIdleStop(plane.services)("ws_idle", epoch, { idleBefore: Date.now() })).ok).toBe(true)
  expect(plane.notices).toEqual([{ workspaceId: "ws_person", step: "stopped" }, { workspaceId: "ws_idle", step: "stopped" }])
})

test("a stop refused because the lease moved on tells nobody", async () => {
  const plane = await composedPlane(scriptedDriver())
  const epoch = await plane.ready("ws_moved")
  expect(await plane.manager.stop("ws_moved", { expectedEpoch: epoch + 1 })).toEqual({ ok: false, reason: "runtime_lease_changed" })
  expect(plane.notices).toEqual([])
})

test("the liveness reconcile ending the lease of a host the provider stopped or lost tells the owner's open clients once, and a serving host tells nobody", async () => {
  let host: "serving" | "stopped" | "gone" = "serving"
  const plane = await composedPlane(scriptedDriver({ host: () => host }))
  const stoppedEpoch = await plane.ready("ws_stopped")
  expect(await plane.manager.endIfHostDown("ws_stopped", stoppedEpoch)).toBeUndefined()
  expect(plane.notices).toEqual([])

  host = "stopped"
  expect(await plane.manager.endIfHostDown("ws_stopped", stoppedEpoch)).toBe("stopped")
  expect(await plane.manager.endIfHostDown("ws_stopped", stoppedEpoch)).toBeUndefined()
  host = "serving"
  const goneEpoch = await plane.ready("ws_gone")
  host = "gone"
  expect(await plane.manager.endIfHostDown("ws_gone", goneEpoch)).toBe("gone")
  expect(plane.notices).toEqual([{ workspaceId: "ws_stopped", step: "stopped" }, { workspaceId: "ws_gone", step: "stopped" }])
})

test("Start fresh on an asleep workspace tells the owner's open clients once, and one refused while the machine runs tells nobody", async () => {
  const plane = await composedPlane(scriptedDriver({ persistence: CAPTURES_TO_NEW_RESOURCE }))
  await plane.ready("ws_fresh")
  expect(await plane.manager.startFresh("ws_fresh")).toEqual({ ok: false, reason: "workspace_running" })
  expect(plane.notices).toEqual([])

  expect((await plane.manager.stop("ws_fresh")).ok).toBe(true)
  expect((await plane.manager.startFresh("ws_fresh")).ok).toBe(true)
  expect(plane.notices).toEqual([{ workspaceId: "ws_fresh", step: "stopped" }, { workspaceId: "ws_fresh", step: "stopped" }])
})
