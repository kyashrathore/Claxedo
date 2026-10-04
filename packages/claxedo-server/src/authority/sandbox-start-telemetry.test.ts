import { afterEach, expect, test, vi } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import type { SandboxDriver } from "@claxedo/sandbox-manager"
import { createMemoryLeaseStore } from "@claxedo/sandbox-manager/stores/memory"
import { composeProviderNeutralHostedControlPlane } from "./provider-neutral-hosted-services"

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

async function captureServer() {
  const captured: Array<{ event: string; distinct_id: string; properties: Record<string, unknown> }> = []
  const server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => { body += chunk })
    request.on("end", () => {
      if (request.url === "/capture/") captured.push(JSON.parse(body))
      response.end("{}")
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { captured, host: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

const driver: SandboxDriver = {
  id: "test",
  metadata: {
    driverRunsIn: ["node"], hostStopBehavior: "suspends-host", hostResumeBehavior: "same-host", targetAccess: "relay", secretBrokering: "none", egressControl: "hosts-and-cidrs",
    persistence: { resume: "same-sandbox", capture: "none", clone: false, captureSource: "not-applicable", retention: "not-applicable", restoreMount: "not-applicable" },
  },
  ensureHost: async (input) => {
    await input.onResource?.({ sandboxId: "sb_1", hostId: "host_1", labels: input.labels })
    await input.onImageReady?.()
    return { sandboxId: "sb_1", url: "https://sandbox.test", hostId: "host_1", labels: input.labels }
  },
}

test("a hosted control plane reports each cloud start phase as an ops event tagged with the project, never the repository", async () => {
  const telemetry = await captureServer()
  const key = await generateKeyPair("EdDSA", { extractable: true })
  const { services } = composeProviderNeutralHostedControlPlane({
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
    CLAXEDO_WORKSPACE_RELAY_URL: "https://relay.claxedo.test",
    CLAXEDO_RELAY_RESOLVER_TOKEN: "relay-resolver-secret",
    CLAXEDO_SANDBOX_DRIVER: driver.id,
    CLAXEDO_TELEMETRY_MODE: "on",
    CLAXEDO_POSTHOG_KEY: "phc_test",
    CLAXEDO_POSTHOG_HOST: telemetry.host,
  }, {
    auth: { config: { enabled: true, mode: "signed" } } as never,
    authority: {} as never,
    hostTunnelResolver: (async () => undefined) as never,
    sandbox: { driver, leaseStore: createMemoryLeaseStore() },
  })

  await services.sandbox.sandboxManager!.ensure("ws_1", {
    homeRegion: "eu-west",
    labels: { projectId: "prj_1" },
    source: { kind: "git", repoUrl: "https://github.com/acme/private.git" },
  })

  await vi.waitFor(() => expect(telemetry.captured.filter((entry) => entry.event === "sandbox.start_phase")).toHaveLength(4))
  const phases = telemetry.captured.filter((entry) => entry.event === "sandbox.start_phase")
  expect(phases.map((entry) => entry.properties.phase)).toEqual(["lease_decision", "provider_ready", "image_ready", "runtime_ready"])
  for (const entry of phases) {
    expect(entry.distinct_id).toBe("system")
    expect(entry.properties).toMatchObject({ workspace_id: "ws_1", epoch: 1, driver: "test", region: "eu-west", boot_mode: "cold-start", project_id: "prj_1", duration_ms: expect.any(Number) })
    expect(JSON.stringify(entry.properties)).not.toContain("acme")
  }
})
