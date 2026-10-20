import path from "node:path"

import { describe, expect, test } from "vitest"

import {
  certifiedHostedWorkerArtifact,
  requireNonLegacyWorkerName,
  selectHostedWorkerArtifact,
} from "../../src/deployments/hosted-workerd/certified-worker-artifacts"
import { renderAppWranglerConfig, renderEdgeWorkerWranglerConfig, renderSessionHostWranglerConfig, renderWorkerWranglerConfig } from "./wrangler-config"

const serverRoot = path.resolve(import.meta.dirname, "../..")
const configDirectory = path.join(serverRoot, ".claxedo-cloudflare-deploy-test")

function render(overrides: Partial<Parameters<typeof renderWorkerWranglerConfig>[0]> = {}) {
  return renderWorkerWranglerConfig({
    workerName: "claxedo",
    artifact: certifiedHostedWorkerArtifact("user-deployed-better-auth-d1"),
    configDirectory,
    authDatabase: { name: "claxedo-auth", id: "11111111-1111-4111-8111-111111111111" },
    controlPlaneDatabase: { name: "claxedo-control-plane", id: "33333333-3333-4333-8333-333333333333" },
    controlPlaneMigrationsDir: "migrations/control-plane",
    requestLimiterNamespaceId: "2101",
    documentsBucket: "claxedo-documents",
    publicOriginHost: "app.example.com",
    variables: { CLAXEDO_DEPLOYMENT_ID: "claxedo", BETTER_AUTH_URL: "https://app.example.com" },
    ...overrides,
  })
}

function renderEdge(overrides: Partial<Parameters<typeof renderWorkerWranglerConfig>[0]> = {}) {
  return renderEdgeWorkerWranglerConfig({
    workerName: "claxedo",
    edgeWorkerName: "claxedo-edge",
    artifact: certifiedHostedWorkerArtifact("user-deployed-better-auth-d1-agent-plugins-full-hosted"),
    configDirectory,
    authDatabase: { name: "claxedo-auth", id: "11111111-1111-4111-8111-111111111111" },
    controlPlaneDatabase: { name: "claxedo-control-plane", id: "33333333-3333-4333-8333-333333333333" },
    controlPlaneMigrationsDir: "migrations/control-plane",
    requestLimiterNamespaceId: "2101",
    documentsBucket: "claxedo-documents",
    agentPluginsBucket: "claxedo-agent-plugins",
    publicOriginHost: "app.example.com",
    variables: { CLAXEDO_DEPLOYMENT_ID: "claxedo", BETTER_AUTH_URL: "https://app.example.com" },
    ...overrides,
  })
}

describe("the user-deployed Worker Wrangler config", () => {
  test("names the Worker, its entry and both databases relative to where the config is written", () => {
    const config = render()
    expect(config).toContain('name = "claxedo"')
    expect(config).toContain('main = "../src/deployments/hosted-workerd/better-auth-d1-worker.cf.ts"')
    expect(config).toContain('migrations_dir = "../migrations/auth"')
    expect(config).toContain('migrations_dir = "migrations/control-plane"')
    expect(config).toContain('database_id = "11111111-1111-4111-8111-111111111111"')
    expect(config).toContain("workers_dev = false")
    expect(config).toContain('[vars]\nBETTER_AUTH_URL = "https://app.example.com"\nCLAXEDO_DEPLOYMENT_ID = "claxedo"')
  })

  test("the writer has no route and is placed smartly unless the deployment pins it beside the databases", () => {
    expect(render()).not.toContain("routes =")
    expect(render()).toContain('[placement]\nmode = "smart"')
    const pinned = render({ placementRegion: "aws:us-east-1" })
    expect(pinned).toContain('[placement]\nregion = "aws:us-east-1"')
    expect(pinned).not.toContain('mode = "smart"')
  })

  test("the edge holds the control plane's routes on the public origin's host, declared before the bundle contract's alias table, and has no placement", () => {
    const config = renderEdge({ placementRegion: "aws:us-east-1" })
    const routes = '\nroutes = ["app.example.com/api/*", "app.example.com/internal/*", "app.example.com/.well-known/*", "app.example.com/bindings/*", "app.example.com/health*", "app.example.com/global/health*", "app.example.com/path*"]\n'
    expect(config).toContain('name = "claxedo-edge"')
    expect(config).toContain(routes)
    expect(config.indexOf(routes)).toBeLessThan(config.indexOf("[alias]"))
    expect(config).toContain(`${routes}compatibility_date = `)
    expect(config).not.toContain("[placement]")
    expect(() => renderEdge({ publicOriginHost: "https://app.example.com" })).toThrow(/bare hostname/)
  })

  test("the edge binds the writer by name and reaches the writer's Durable Objects by script, defining none of its own", () => {
    const config = renderEdge()
    expect(config).toContain('[[services]]\nbinding = "CONTROL_PLANE_WRITER"\nservice = "claxedo"')
    for (const [name, className] of [["LIVE_SYNC_ROOM", "LiveSyncRoom"], ["PLUGIN_SUPERVISOR", "PluginSupervisor"], ["SANDBOX_PROVISIONER", "SandboxProvisioner"]]) {
      expect(config).toContain(`[[durable_objects.bindings]]\nname = "${name}"\nclass_name = "${className}"\nscript_name = "claxedo"`)
    }
    expect(config).not.toContain("[[migrations]]")
    const writer = render({ artifact: certifiedHostedWorkerArtifact("user-deployed-better-auth-d1-agent-plugins-full-hosted"), agentPluginsBucket: "claxedo-agent-plugins" })
    expect(writer).not.toContain("script_name")
    expect(writer).not.toContain("CONTROL_PLANE_WRITER")
    expect(writer.slice(writer.indexOf("[vars]"), writer.indexOf("[[durable_objects.bindings]]")).trim())
      .toBe(config.slice(config.indexOf("[vars]"), config.indexOf("[[services]]")).trim())
  })

  test("binds the documents bucket on every Worker profile", () => {
    expect(render()).toContain('binding = "CLAXEDO_DOCUMENTS"\nbucket_name = "claxedo-documents"')
  })

  test("declares the Cloudflare Email Service binding", () => {
    expect(render()).toContain('[[send_email]]\nname = "EMAIL"')
  })

  test("pins the shared rate-limit window and ceiling to the local fuse", () => {
    // Cloudflare accepts only 10 or 60 for `period`, and the hosted app's own
    // limiter runs on a 60_000 ms window, so 10 would make the shared ceiling
    // six times tighter than `limit` says.
    expect(render()).toContain("[ratelimits.simple]\nlimit = 600\nperiod = 60")
    expect(() => render({ requestLimiterNamespaceId: "0" })).toThrow(/positive safe integers/)
  })

  test("binds the plugin bucket for the Agent Plugins artifacts and only for them", () => {
    const agentPlugins = certifiedHostedWorkerArtifact("user-deployed-better-auth-d1-agent-plugins")
    const config = render({ artifact: agentPlugins, agentPluginsBucket: "claxedo-agent-plugins" })
    expect(config).toContain('binding = "CLAXEDO_AGENT_PLUGINS"\nbucket_name = "claxedo-agent-plugins"')
    expect(() => render({ artifact: agentPlugins })).toThrow(/plugin artifact bucket/)
    expect(() => render({ agentPluginsBucket: "claxedo-agent-plugins" })).toThrow(/plugin artifact bucket/)
  })

  test("binds the sandbox provisioner, under its own migration tag, for the full-hosted artifact and only for it", () => {
    const fullHosted = certifiedHostedWorkerArtifact("user-deployed-better-auth-d1-agent-plugins-full-hosted")
    const config = render({ artifact: fullHosted, agentPluginsBucket: "claxedo-agent-plugins" })
    expect(config).toContain('[[durable_objects.bindings]]\nname = "SANDBOX_PROVISIONER"\nclass_name = "SandboxProvisioner"')
    expect(config).toContain('[[migrations]]\ntag = "v3"\nnew_sqlite_classes = ["SandboxProvisioner"]')
    const agentPlugins = certifiedHostedWorkerArtifact("user-deployed-better-auth-d1-agent-plugins")
    expect(render({ artifact: agentPlugins, agentPluginsBucket: "claxedo-agent-plugins" })).not.toMatch(/SandboxProvisioner|SANDBOX_PROVISIONER/)
  })

  test("refuses a variable that would render as an empty or padded TOML string", () => {
    expect(() => render({ variables: { CLAXEDO_DEPLOYMENT_ID: " claxedo" } })).toThrow(/trimmed/)
  })

  test("renders the app as the public origin: SPA-routed assets behind the Worker, the relay bound and no control-plane binding", () => {
    const browserDirectory = path.join(serverRoot, "app")
    const config = renderAppWranglerConfig({ appWorkerName: "claxedo-app", relayWorkerName: "claxedo-relay", browserDirectory })
    expect(config).toContain('name = "claxedo-app"')
    expect(config).toContain(`main = ${JSON.stringify(path.join(serverRoot, "scripts/deploy/app-worker.ts"))}`)
    expect(config).toContain(`directory = ${JSON.stringify(browserDirectory)}`)
    expect(config).toContain('binding = "ASSETS"')
    expect(config).toContain('not_found_handling = "single-page-application"')
    expect(config).toContain("run_worker_first = true")
    expect(config).not.toContain("CONTROL_PLANE")
    expect(config).toContain('binding = "RELAY"\nservice = "claxedo-relay"')
  })
})

describe("certified Worker artifacts", () => {
  test("select by feature, and full-hosted exists only as an Agent Plugins artifact", () => {
    expect(selectHostedWorkerArtifact({ agentPlugins: false, fullHosted: false }).artifactId).toBe(
      "user-deployed-better-auth-d1",
    )
    expect(selectHostedWorkerArtifact({ agentPlugins: true, fullHosted: false }).artifactId).toBe(
      "user-deployed-better-auth-d1-agent-plugins",
    )
    expect(selectHostedWorkerArtifact({ agentPlugins: true, fullHosted: true }).artifactId).toBe(
      "user-deployed-better-auth-d1-agent-plugins-full-hosted",
    )
    expect(() => selectHostedWorkerArtifact({ agentPlugins: false, fullHosted: true })).toThrow(/--agent-plugins/)
    expect(() => certifiedHostedWorkerArtifact("user-deployed-better-auth-d1-locked")).toThrow(/not certified/)
  })

  test("reserve legacy Worker names with their append-only Durable Object migration history", () => {
    expect(() => requireNonLegacyWorkerName("claxedo-control-plane")).toThrow(/append-only Durable Object/)
    expect(() => requireNonLegacyWorkerName("Claxedo")).toThrow(/valid Cloudflare Worker identifiers/)
    expect(requireNonLegacyWorkerName("claxedo")).toBe("claxedo")
  })
})

describe("the session-host Worker Wrangler config", () => {
  test("hosts SessionDO under nodejs_compat, binds the control plane by name and reads its variables", () => {
    const config = renderSessionHostWranglerConfig({
      workerName: "claxedo-session-host", controlPlaneWorkerName: "claxedo", configDirectory,
      variables: { WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL: "https://api.example.com/api/runtime-authority/session-authorize" },
    })
    expect(config).toContain('name = "claxedo-session-host"')
    expect(config).toContain('main = "../../session-host/src/worker.ts"')
    expect(config).toContain('compatibility_flags = ["nodejs_compat"]')
    expect(config).toContain('[[services]]\nbinding = "CONTROL_PLANE"\nservice = "claxedo"')
    expect(config).toContain('[[durable_objects.bindings]]\nname = "SESSION_HOST"\nclass_name = "SessionDO"')
    expect(config).toContain('[[migrations]]\ntag = "v1"\nnew_sqlite_classes = ["SessionDO"]')
    expect(config).toContain('[vars]\nWORKSPACE_RUNTIME_SESSION_AUTHORITY_URL = "https://api.example.com/api/runtime-authority/session-authorize"')
    expect(config).not.toContain("[placement]")
  })
})
