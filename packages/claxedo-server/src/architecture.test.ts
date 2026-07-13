import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { getSessionWriteMode, harnessHostForHarness, workspaceProfileForHarness } from "./architecture"
import { architectureOwnershipEntries, OwnershipStatus } from "./architecture-ownership"
import { routeOwnership, RouteHandler } from "./route-ownership"
import { importPattern, walk } from "./test-helpers/guards"

describe("harness-scoped resolution", () => {
  test("classifies host primitive architecture modules with owners and removal conditions", () => {
    const entries = architectureOwnershipEntries()
    const areas = new Set(entries.map((entry) => entry.area))
    expect([...areas].sort()).toEqual(["authority", "host", "lease", "mirror", "projection", "registry", "route"])

    const keys = entries.map((entry) => `${entry.area}:${entry.module}`)
    expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([])

    for (const entry of entries) {
      const target = path.resolve(import.meta.dirname, entry.module)
      if (entry.status === OwnershipStatus.Deleted) {
        expect(fs.existsSync(target), `${entry.module} should stay deleted`).toBe(false)
        expect(entry.canonicalReplacement).toBeTruthy()
        continue
      }

      expect(fs.existsSync(target), `${entry.module} should exist`).toBe(true)
      expect(entry.owner, `${entry.module} needs an owner`).toBeTruthy()
      expect(entry.tests?.length, `${entry.module} needs active test coverage`).toBeGreaterThan(0)
      for (const testFile of entry.tests ?? []) {
        expect(
          fs.existsSync(path.resolve(import.meta.dirname, testFile)),
          `${entry.module} test missing: ${testFile}`,
        ).toBe(true)
      }

      if (entry.status === OwnershipStatus.Compatibility) {
        expect(entry.reason, `${entry.module} compatibility reason missing`).toBeTruthy()
        expect(entry.canonicalReplacement, `${entry.module} canonical replacement missing`).toBeTruthy()
        expect(entry.removalCondition, `${entry.module} removal condition missing`).toBeTruthy()
      }

      for (const sample of entry.routeSamples ?? []) {
        expect(routeOwnership(sample).handler, `${entry.module} route sample ${sample} is unclaimed`).not.toBe(
          RouteHandler.Unclaimed,
        )
      }
    }
  })

  test("covers discovered host primitive modules in the ownership table", () => {
    const owned = new Set(architectureOwnershipEntries().map((entry) => entry.module))
    const required = [
      "control-plane/adapters/convex/convex-authority.ts",
      "cloud/authority.ts",
      "cloud/authority-types.ts",
      "cloud/lifecycle",
      "../../sandbox-manager/src/index.ts",
      "../../sandbox-manager/src/stores/memory.ts",
      "sandbox-manager-adapters/stores/sqlite.ts",
      "sandbox-manager-adapters/stores/convex.ts",
      "sandbox-manager-adapters/provision-events.ts",
      "workspace-supervisor-sandbox.ts",
      "runtime-lifecycle/index.ts",
      "control-plane/http.ts",
      "cloud/mirror.ts",
      "cloud/message-replay.ts",
      "cloud/session-sync.ts",
      "credentials/registry.ts",
      "control-plane/worker-credentials.ts",
      "agent-extensions/catalog.ts",
      "cloud/sandbox",
      "../../sandbox-manager/src/sandbox-pool.ts",
      "embedded-workspace-runtime.ts",
      "sandbox-target-fetch.ts",
      "config-fanout.ts",
      "../../workspace-runtime/src/workspace/host.ts",
      "../../workspace-runtime/src/workspace/runtime.ts",
      "../../workspace-runtime/src/workspace/core.ts",
      "proxy.ts",
      "route-ownership.ts",
      "routes/local-only-projection.ts",
      "routes/opencode-compat.ts",
      "control-plane/projection-store.ts",
      "control-plane/durable-session-log.ts",
    ]

    expect(required.filter((module) => !owned.has(module))).toEqual([])
  })

  test("keeps src/cloud limited to projection and mirror modules", () => {
    const serverSrc = path.resolve(import.meta.dirname)
    const activeCloudModules = walk(path.join(serverSrc, "cloud"))
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => !file.endsWith(".test.ts"))
      .map((file) => path.relative(serverSrc, file))
      .sort()

    expect(activeCloudModules).toEqual([
      "cloud/message-replay.ts",
      "cloud/mirror.ts",
      "cloud/session-sync.ts",
    ])

    const ownership = new Map(architectureOwnershipEntries().map((entry) => [entry.module, entry]))
    for (const module of activeCloudModules) {
      const entry = ownership.get(module)
      expect(entry?.status, `${module} should be a canonical owned module`).toBe(OwnershipStatus.Canonical)
      expect(["mirror", "projection"], `${module} should not own provider or lease behavior`).toContain(entry?.area)
    }
  })

  test("keeps the server host bridge out of harness adapter execution", () => {
    const files = ["embedded-workspace-runtime.ts", "sandbox-target-fetch.ts", "proxy.ts", "config-fanout.ts"]
    const forbidden = [
      "@claxedo/agent-sdk-runtime",
      "AcpHarnessAdapter",
      "OpenCodeHarnessAdapter",
      "ClaudeHarnessAdapter",
      "CursorHarnessAdapter",
      "CodexHarnessAdapter",
    ]
    const hits = files.flatMap((file) => {
      // The boundary is about EXECUTION: the host bridge must not *run* harness
      // adapters. `import type ... ` is erased at compile time and produces no
      // runtime coupling, so a type-only import (e.g. a Pi backend resolver type
      // used to shape a config field) is not a violation — strip those lines
      // before scanning.
      const text = fs
        .readFileSync(path.resolve(import.meta.dirname, file), "utf-8")
        .split("\n")
        .filter((line) => !/^\s*import\s+type\b/.test(line))
        .join("\n")
      return forbidden.flatMap((term) => (text.includes(term) ? [`${file}:${term}`] : []))
    })

    expect(hits).toEqual([])
  })

  test("keeps workspace-runtime from importing claxedo-server", () => {
    const workspaceRuntimeSrc = path.resolve(import.meta.dirname, "../../workspace-runtime/src")
    const forbidden = ["@claxedo/server", "@opencode-ai/claxedo-server", "@claxedo/claxedo-server", "claxedo-server"]
    const offenders = walk(workspaceRuntimeSrc)
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => !file.endsWith(".test.ts"))
      .flatMap((file) => {
        const text = fs.readFileSync(file, "utf8")
        return forbidden.flatMap((term) =>
          importPattern(term).test(text) ? [`${path.relative(workspaceRuntimeSrc, file)}:${term}`] : [],
        )
      })

    expect(offenders).toEqual([])
  })

  test("keeps product strings and ambient policy env reads out of the workspace-runtime kit", () => {
    const workspaceRuntimeSrc = path.resolve(import.meta.dirname, "../../workspace-runtime/src")
    // Product domains and host-policy env flags are HOST decisions
    // (kit-seams plan, Classification Rule). The kit must not embed them:
    // CORS whitelists arrive via options.corsOrigin, compat via
    // options.opencodeCompat.
    const forbidden = ["opencode.ai", "DISABLE_OPENCODE_COMPAT"]
    const offenders = walk(workspaceRuntimeSrc)
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => !file.endsWith(".test.ts"))
      .flatMap((file) => {
        const text = fs.readFileSync(file, "utf8")
        return forbidden.flatMap((term) =>
          text.includes(term) ? [`${path.relative(workspaceRuntimeSrc, file)}:${term}`] : [],
        )
      })

    expect(offenders).toEqual([])
  })

  test("keeps existing harnesses on workspace-hosted execution", () => {
    expect(harnessHostForHarness({ id: "opencode" })).toBe("workspace")
    expect(harnessHostForHarness({ id: "claude" })).toBe("workspace")
    expect(workspaceProfileForHarness({ id: "codex" })).toBe("workspace")
    expect(getSessionWriteMode({ id: "cursor" })).toBe("workspace_replicated")
  })

  test("keeps sandbox profile singular", () => {
    expect([
      workspaceProfileForHarness({ id: "opencode" }),
      workspaceProfileForHarness({ id: "claude" }),
      workspaceProfileForHarness({ id: "codex" }),
      workspaceProfileForHarness({ id: "cursor" }),
    ]).toEqual(["workspace", "workspace", "workspace", "workspace"])

    const workspaceRuntimeFiles = walk(path.resolve(import.meta.dirname, "../../workspace-runtime/src")).map((file) =>
      path.relative(path.resolve(import.meta.dirname, "../.."), file),
    )
    expect(
      workspaceRuntimeFiles.filter((file) => file.includes("workspace-minimal") || file.includes("workspace-full")),
    ).toEqual([])
  })

  test("keeps retired compatibility wrappers out of server source", () => {
    const serverSrc = path.resolve(import.meta.dirname)
    const retiredWrappers = [
      "routes/agent-hook.ts",
      "routes/process.ts",
      "routes/pty.ts",
      "routes/pty-proxy.ts",
      "routes/supervisor-backplane.ts",
      "agent-hooks.ts",
      "process/client.ts",
      "process/diagnostics.ts",
      "process/index.ts",
      "process/portpick.ts",
      "process/process.ts",
      "pty/index.ts",
      "mcp/batch-issues.ts",
      "mcp/process-handler.ts",
      "cloud/authority.ts",
      "cloud/authority-types.ts",
      "cloud/provider.ts",
      "cloud/sandbox-cloudflare.ts",
      "cloud/sandbox-daytona.ts",
      "cloud/sandbox-handle.ts",
      "cloud/sandbox-image.ts",
      "cloud/sandbox-modal.ts",
      "cloud/sandbox-pool.test.ts",
      "cloud/sandbox-pool.ts",
      "cloud/sandbox-runtime.ts",
      "cloud/sandbox-vercel.ts",
      "cloud/workspace-supervisor.test.ts",
      "workspace-supervisor-remote-runtime.ts",
      "../../sandbox-manager/src/sandbox-pool-registry.test.ts",
      "../../sandbox-manager/src/sandbox-pool.test.ts",
      "../../sandbox-manager/src/sandbox-pool.ts",
      "../../sandbox-manager/src/drivers/sandbox-bridge.test.ts",
      "../../sandbox-manager/src/drivers/sandbox-bridge.ts",
      "../../sandbox-manager/src/handle-providers",
      "../../sandbox-manager/src/sandbox-bridge-contract.ts",
      "../../sandbox-manager/src/sandbox-bridge-provider.ts",
      "../../sandbox-manager/src/workspace-runtime-process.test.ts",
      "../../sandbox-manager/src/workspace-runtime-process.ts",
      "harness/host.ts",
      "harness/pi-adapter.ts",
      "harness/pi-brokers.test.ts",
      "harness/pi-brokers.ts",
      "harness/pi-host.ts",
      "harness/pi-session-store.ts",
      "harness/pi-support.ts",
      "harness/pi-tools.test.ts",
      "harness/pi-tools.ts",
      "harness/workspace-runtime-api.ts",
      "harness/workspace-session-env.ts",
      "../../workspace-runtime/src/sandbox-manager.ts",
    ]

    expect(retiredWrappers.filter((file) => fs.existsSync(path.join(serverSrc, file)))).toEqual([])
  })

  test("keeps production source from importing legacy host-control modules", () => {
    const serverSrc = path.resolve(import.meta.dirname)
    const forbiddenModules = [
      "cloud/authority",
      "cloud/lifecycle",
      "cloud/sandbox",
      "../../sandbox-manager/src/sandbox-pool",
      "../../sandbox-manager/src/drivers/sandbox-bridge",
      "../../sandbox-manager/src/handle-providers",
      "../../sandbox-manager/src/sandbox-bridge-contract",
      "../../sandbox-manager/src/sandbox-bridge-provider",
      "../../sandbox-manager/src/workspace-runtime-process",
    ]
    const offenders = walk(serverSrc)
      .filter((file) => file.endsWith(".ts") || file.endsWith(".mjs"))
      .filter((file) => !file.endsWith(".test.ts"))
      .filter((file) => !file.startsWith(path.join(serverSrc, "cloud", "sandbox") + path.sep))
      .filter((file) => !path.basename(file).startsWith("live-"))
      .flatMap((file) => {
        const text = fs.readFileSync(file, "utf8")
        return forbiddenModules.flatMap((forbidden) =>
          importPattern(forbidden).test(text) ? [`${path.relative(serverSrc, file)}:${forbidden}`] : [],
        )
      })

    expect(offenders).toEqual([])
  })

  test("keeps SandboxDriver focused on host lifecycle", () => {
    const text = fs.readFileSync(path.resolve(import.meta.dirname, "../../sandbox-manager/src/index.ts"), "utf8")
    const start = text.indexOf("export type SandboxDriver = {")
    const end = text.indexOf("\n\nexport type SandboxManager =", start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)

    const driverContract = text.slice(start, end)
    const forbidden = [
      "executeCommand",
      "uploadFile",
      "createSession",
      "executeSessionCommand",
      "deleteSession",
      "launch",
      "restart",
      "recoverHost",
      "exec",
      "pty",
    ]

    expect(forbidden.filter((term) => driverContract.includes(term))).toEqual([])
  })

  test("keeps sandbox-manager public types from becoming sandbox handles", () => {
    const text = fs.readFileSync(path.resolve(import.meta.dirname, "../../sandbox-manager/src/index.ts"), "utf8")
    const forbidden = [
      "executeCommand",
      "uploadFile",
      "downloadFile",
      "readFile",
      "writeFile",
      "createSession",
      "executeSessionCommand",
      "deleteSession",
      "SandboxHandle",
      "SandboxProvider",
    ]

    expect(forbidden.filter((term) => text.includes(term))).toEqual([])
  })

  test("keeps SandboxManager wired to a driver, not a provider object", () => {
    const text = fs.readFileSync(path.resolve(import.meta.dirname, "../../sandbox-manager/src/index.ts"), "utf8")
    const start = text.indexOf("export type SandboxManagerOptions = {")
    const end = text.indexOf("\n\nfunction sandboxId", start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)

    const optionsContract = text.slice(start, end)
    expect(optionsContract).toContain("driver: SandboxDriver")
    expect(optionsContract).not.toContain("provider: SandboxDriver")
  })

  test("keeps SandboxManager storage/auth pluggable", () => {
    const serverSrc = path.resolve(import.meta.dirname)
    const genericRuntimeHostFiles = [
      "../../sandbox-manager/src/index.ts",
      "../../sandbox-manager/src/stores/memory.ts",
    ]
    const forbiddenTerms = [
      "ConvexHttpClient",
      "convex/server",
      "service_token",
      "CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN",
      "storage/workspace-lease.sql",
      "better-sqlite",
      "workspace-store",
      "workspaceStore",
      "process.env",
      "Bun.file",
      "Clerk",
      "billing",
      "usersMe",
    ]

    const offenders = genericRuntimeHostFiles.flatMap((file) => {
      const text = fs.readFileSync(path.resolve(serverSrc, file), "utf8")
      return forbiddenTerms
        .filter((term) => text.includes(term))
        .map((term) => `${file}:${term}`)
    })

    expect(offenders).toEqual([])
  })

  test("keeps generic control-plane core free of Convex tokens (R8)", () => {
    // Ownership-first: Convex is Claxedo's storage *decision*; only the Convex
    // (and the Worker composition) adapters under control-plane/adapters/* may
    // name it. Every other control-plane source file — imports, error codes,
    // field names, env names, comments — must be storage-agnostic. This is the
    // mechanical mirror of the kit's opencode.ai ban. Test files are excluded.
    // (Even the legacy backend-URL env aliases live in the Convex adapter now:
    // `convexAuthorityUrlFromEnv` — so this scan needs no carve-outs.)
    const controlPlaneSrc = path.resolve(import.meta.dirname, "control-plane")
    const offenders = walk(controlPlaneSrc)
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => !file.endsWith(".test.ts"))
      .filter((file) => !file.includes(`${path.sep}adapters${path.sep}`))
      .filter((file) => /convex/i.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(controlPlaneSrc, file))
      .sort()

    expect(offenders).toEqual([])
  })

  test("keeps SandboxLease as the canonical manager lease name", () => {
    const serverSrc = path.resolve(import.meta.dirname)
    const productionFiles = walk(serverSrc)
      .filter((file) => file.endsWith(".ts") || file.endsWith(".mjs"))
      .filter((file) => !file.endsWith(".test.ts"))
      .map((file) => path.relative(serverSrc, file))
      .sort()

    const filesContaining = (term: string) =>
      productionFiles.filter((file) => fs.readFileSync(path.resolve(serverSrc, file), "utf8").includes(term))

    expect(filesContaining("RuntimeHostLease")).toEqual([])
    expect(filesContaining("runtimeLease")).toEqual([])

    const contract = fs.readFileSync(path.resolve(serverSrc, "../../sandbox-manager/src/index.ts"), "utf8")
    expect(contract).toContain("export type SandboxLease = {")
    expect(contract).not.toContain("export type RuntimeHostLease")

    const rowContract = fs.readFileSync(path.resolve(serverSrc, "../../sandbox-manager/src/lease-types.ts"), "utf8")
    expect(rowContract).toContain("export type SandboxLeaseRow = {")
    expect(rowContract).not.toContain("export type SandboxLease = {")
  })

  test("keeps local supervisor targets on lease host identity, not sandbox identity", () => {
    const hostLease = fs.readFileSync(
      path.resolve(import.meta.dirname, "sandbox-manager-adapters", "stores", "sqlite-supervisor-state.ts"),
      "utf8",
    )
    const supervisor = fs.readFileSync(path.resolve(import.meta.dirname, "workspace-supervisor.ts"), "utf8")
    const controlToken = fs.readFileSync(
      path.resolve(import.meta.dirname, "workspace-supervisor-control-token.ts"),
      "utf8",
    )

    expect(hostLease).toContain("const hostId = lease?.lease_id || sandboxId")
    expect(hostLease).toContain("hostId: lease.lease_id || undefined")
    expect(hostLease).not.toContain("hostId: sandboxId")
    expect(hostLease).not.toContain("hostId: lease.sandbox_id")

    expect(supervisor).toContain("const hostId = state.relay_host_id ?? lease?.lease_id ?? state.sandbox_id")
    expect(supervisor).not.toContain("hostId: state.sandbox_id")

    expect(controlToken).toContain("state.sandbox_target?.hostId ?? state.relay_host_id")
    expect(controlToken.indexOf("state.sandbox_target?.hostId")).toBeLessThan(controlToken.indexOf("state.sandbox_id"))
  })

  test("keeps workspace rows from being the runtime host location authority", () => {
    const serverSrc = path.resolve(import.meta.dirname)
    const route = fs.readFileSync(path.resolve(serverSrc, "routes", "workspace.ts"), "utf8")
    const backing = fs.readFileSync(path.resolve(serverSrc, "workspace-backing.ts"), "utf8")
    const supervisorRuntimeHost = fs.readFileSync(
      path.resolve(serverSrc, "workspace-supervisor-sandbox.ts"),
      "utf8",
    )
    const supervisor = fs.readFileSync(path.resolve(serverSrc, "workspace-supervisor.ts"), "utf8")
    const controlToken = fs.readFileSync(
      path.resolve(serverSrc, "workspace-supervisor-control-token.ts"),
      "utf8",
    )
    const workspaceStore = fs.readFileSync(path.resolve(serverSrc, "workspace-store.ts"), "utf8")
    const ensureWorkspaceInput = workspaceStore.slice(
      workspaceStore.indexOf("export async function ensureWorkspace(input: {"),
      workspaceStore.indexOf("}) {", workspaceStore.indexOf("export async function ensureWorkspace(input: {")),
    )
    const updateWorkspaceInput = workspaceStore.slice(
      workspaceStore.indexOf("export async function updateWorkspace("),
      workspaceStore.indexOf(") {", workspaceStore.indexOf("export async function updateWorkspace(")),
    )

    expect(route).not.toContain("sandboxId: ws.sandbox_id")
    expect(route).not.toContain("sandbox_id,")
    expect(backing).not.toContain("sandboxId?:")
    expect(backing).not.toContain("sandboxId: workspace.sandbox_id")
    expect(supervisorRuntimeHost).not.toContain("sandbox_id: target.sandboxId")
    expect(supervisorRuntimeHost).not.toContain("state.ws.sandbox_id")
    expect(supervisor).not.toContain("ws.sandbox_id")
    expect(controlToken).not.toContain("state.ws.sandbox_id")
    expect(ensureWorkspaceInput).not.toContain("sandbox_id")
    expect(updateWorkspaceInput).not.toContain("sandbox_id")
  })

  test("keeps sandbox drivers from becoming sandbox remote-control APIs", () => {
    const serverSrc = path.resolve(import.meta.dirname)
    const driversSrc = path.resolve(serverSrc, "../../sandbox-manager/src/drivers")
    const allowedProviderSdkBootPrimitives = new Set([path.join(driversSrc, "daytona.ts")])
    const forbiddenTerms = ["uploadFile", "createSession", "executeSessionCommand", "deleteSession", "pty"]
    const execFacade = /\bexec\s*:|\.exec\s*\(/
    const offenders = walk(driversSrc)
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => !file.endsWith(".test.ts"))
      .flatMap((file) => {
        const text = fs.readFileSync(file, "utf8")
        return [
          ...forbiddenTerms
            .filter((term) => text.includes(term))
            .map((term) => `${path.relative(serverSrc, file)}:${term}`),
          ...(text.includes("executeCommand") && !allowedProviderSdkBootPrimitives.has(file)
            ? [`${path.relative(serverSrc, file)}:executeCommand`]
            : []),
          ...(execFacade.test(text) ? [`${path.relative(serverSrc, file)}:exec-facade`] : []),
        ]
      })

    expect(offenders).toEqual([])
  })

  test("keeps the supported Cloudflare worker from exposing sandbox remote-control actions", () => {
    const worker = fs.readFileSync(
      path.resolve(import.meta.dirname, "..", "scripts", "sandbox", "cloudflare-worker", "src", "index.ts"),
      "utf8",
    )
    const forbiddenActions = [
      "exec",
      "write-file",
      "mkdir",
      "start-process",
      "kill-process",
      "expose-port",
      "network",
      "create-backup",
      "restore-backup",
      "set-env",
    ]

    expect(forbiddenActions.flatMap((action) =>
      worker.includes(`case "${action}"`) ? [action] : []
    )).toEqual([])
    expect(worker).toContain('case "ensure-runtime"')
    expect(worker).toContain('case "touch-runtime"')
  })

  test("keeps live sandbox verification on the product path", () => {
    const serverSrc = path.resolve(import.meta.dirname)
    const packageRoot = path.resolve(serverSrc, "..")
    const liveSrc = path.join(packageRoot, "scripts", "sandbox", "live")
    const liveFiles = walk(liveSrc)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => path.relative(liveSrc, file))
      .sort()

    expect(liveFiles).toEqual(["live-ui-test.ts"])
    expect(
      liveFiles.flatMap((file) => {
        const text = fs.readFileSync(path.join(liveSrc, file), "utf8")
        return [
          "LiveSandboxProbe",
          "live-sandbox-probe",
          "executeCommand",
          "uploadFile",
          "createSession",
          "executeSessionCommand",
          "deleteSession",
          "SANDBOX_DRIVER",
        ].flatMap((term) => text.includes(term) ? [`${file}:${term}`] : [])
      }),
    ).toEqual([])

    const productionRefs = walk(serverSrc)
      .filter((file) => file.endsWith(".ts") || file.endsWith(".mjs"))
      .filter((file) => !file.endsWith(".test.ts"))
      .flatMap((file) => {
        const text = fs.readFileSync(file, "utf8")
        return ["LiveSandboxProbe", "live-sandbox-probe"].flatMap((term) =>
          text.includes(term) ? [`${path.relative(serverSrc, file)}:${term}`] : [],
        )
      })

    expect(productionRefs).toEqual([])
  })

  test("keeps Daytona on the native SDK path instead of an ad hoc REST driver", () => {
    const text = fs.readFileSync(path.resolve(import.meta.dirname, "../../sandbox-manager/src/drivers/daytona.ts"), "utf8")

    expect(text).toContain('from "@daytona/sdk"')
    expect(text).toContain("new Daytona(")
    expect(text).not.toContain("fetch(")
    expect(text).not.toContain("axios")
  })

  test("keeps the hosted fetch bridge explicit-only", () => {
    const text = fs.readFileSync(path.resolve(import.meta.dirname, "control-plane/hosted-services.ts"), "utf8")
    const root = fs.readFileSync(path.resolve(import.meta.dirname, "index.ts"), "utf8")
    const catalog = fs.readFileSync(path.resolve(import.meta.dirname, "../../sandbox-manager/src/driver-catalog.ts"), "utf8")

    expect(text).toContain("defaultSandboxDriverName")
    expect(text).toContain('name !== "fetch"')
    expect(text).not.toContain('?? "fetch"')
    expect(text).not.toContain("default \"fetch\"")
    expect(text).not.toContain("fetch\" (default)")
    expect(root).not.toContain("createFetchBridgeSandboxDriver")
    expect(catalog).not.toContain('"fetch"')
    expect(catalog).not.toContain("Fetch Bridge")
  })

  test("keeps hosted workspace provisioning described as driver ensureHost", () => {
    const text = fs.readFileSync(path.resolve(import.meta.dirname, "routes/hosted-workspace.ts"), "utf8")

    expect(text).toContain("driver.ensureHost")
    expect(text).not.toContain("provider.ensure")
  })

  test("keeps local cloud workspace create on explicit sandbox driver selection", () => {
    const text = fs.readFileSync(path.resolve(import.meta.dirname, "routes/workspace.ts"), "utf8")

    expect(text).toContain("const requestedDriver = body.driver?.trim()")
    expect(text).toContain("isSandboxDriverID(requestedDriver)")
    expect(text).toContain("const requestedId = requestedDriver ? sandboxDriverId(requestedDriver, driverConfig) : undefined")
    expect(text).not.toContain("sandboxDriverId(body.driver")
    expect(text).not.toContain("body.driver ??")
  })

  test("keeps runtimeUrl out of production host-control code", () => {
    const serverSrc = path.resolve(import.meta.dirname)
    const files = walk(serverSrc)
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => !file.endsWith(".test.ts"))
      .map((file) => path.relative(serverSrc, file))
      .filter((file) => fs.readFileSync(path.join(serverSrc, file), "utf8").includes("runtimeUrl"))
      .sort()

    expect(files).toEqual([])
  })

  test("keeps workspace sandbox_url reads out of production control paths", () => {
    const serverSrc = path.resolve(import.meta.dirname)
    const allowedDataModelFiles = new Set(["workspace-store.ts"])
    const readPatterns = [/[\w.)\]]+\.sandbox_url/g, /sandbox_url\?\./g]

    const offenders = walk(serverSrc)
      .filter((file) => file.endsWith(".ts") || file.endsWith(".mjs"))
      .filter((file) => !file.endsWith(".test.ts"))
      .flatMap((file) => {
        const relative = path.relative(serverSrc, file)
        const text = fs.readFileSync(file, "utf8")
        const hits = readPatterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[0]))
        if (hits.length === 0) return []
        if (allowedDataModelFiles.has(relative)) return []
        return hits.map((hit) => `${relative}:${hit}`)
      })

    expect(offenders).toEqual([])
  })

  test("keeps runtime pull routing on canonical sandbox leases", () => {
    const serverSrc = path.resolve(import.meta.dirname)
    const relayOnlyFiles = [
      "control-plane/http-runtime-transport.ts",
      "control-plane/hosted-session-pull.ts",
      "control-plane/http-session-pull.ts",
      "routes/workspace-cloud-connection.ts",
      "sandbox-target-fetch.ts",
    ]
    const forbidden = [
      "sandbox_id ??",
      "sandboxId ??",
      "provider_object_id",
      "providerObjectId",
      "target.url",
      ".sandbox_url",
      ".runtime_url",
    ]

    const offenders = relayOnlyFiles.flatMap((file) => {
      const text = fs.readFileSync(path.resolve(serverSrc, file), "utf8")
      return forbidden
        .filter((term) => text.includes(term))
        .map((term) => `${file}:${term}`)
    })

    expect(offenders).toEqual([])

    for (const file of ["control-plane/http-runtime-transport.ts", "control-plane/hosted-session-pull.ts"]) {
      const text = fs.readFileSync(path.resolve(serverSrc, file), "utf8")
      expect(text, `${file} should read the canonical lease target`).toContain(".target(input.workspaceId)")
      expect(text, `${file} must not provision while pulling sessions`).not.toContain(".ensure(input.workspaceId")
    }

    const relayLookup = fs.readFileSync(path.resolve(serverSrc, "control-plane/sandbox-relay-target.ts"), "utf8")
    expect(relayLookup).toContain("input.sandboxManager.target(args.workspaceId)")
    expect(relayLookup).toContain("target.hostId === args.hostId")
    expect(relayLookup).toContain("baseUrl: target.url")

    const opencodeCompat = fs.readFileSync(path.resolve(serverSrc, "routes/opencode-compat.ts"), "utf8")
    expect(opencodeCompat).not.toContain("target.url")
    expect(opencodeCompat).not.toContain("listSupervisorSandboxs")
    expect(opencodeCompat).not.toContain("rt.url")
    expect(opencodeCompat).toContain("sandboxFetch(ws, \"/agent\"")

    const sandboxFetch = fs.readFileSync(path.resolve(serverSrc, "sandbox-target-fetch.ts"), "utf8")
    expect(sandboxFetch).toContain("relayProvider.mintRuntimeAccessToken")
    expect(sandboxFetch).toContain("relayProvider.getRelayEndpoint")
    expect(sandboxFetch).toContain("/workspaces/")

    const proxy = fs.readFileSync(path.resolve(serverSrc, "proxy.ts"), "utf8")
    expect(proxy).toContain("relayProvider.mintRuntimeAccessToken")
    expect(proxy).toContain("relayProvider.getRelayEndpoint")
    expect(proxy).toContain("direct local")

    const userHostedTunnel = fs.readFileSync(path.resolve(serverSrc, "user-hosted-tunnel.ts"), "utf8")
    const supervisor = fs.readFileSync(path.resolve(serverSrc, "workspace-supervisor.ts"), "utf8")
    const oldRelayProtectedHelper = "ensureRelayProtected" + "Sandbox"
    expect(userHostedTunnel).toContain("createWorkspaceSupervisorSandboxManager")
    expect(userHostedTunnel).toContain("sandboxManager.ensure")
    expect(userHostedTunnel).toContain("hostId: input.hostId")
    expect(userHostedTunnel).toContain("Node-side bridge ingress")
    expect(userHostedTunnel).not.toContain(oldRelayProtectedHelper)
    expect(supervisor).not.toContain(`export async function ${oldRelayProtectedHelper}`)

    const oldHelperReferences = walk(serverSrc)
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => path.relative(serverSrc, file) !== "architecture.test.ts")
      .filter((file) => path.relative(serverSrc, file) !== "workspace-supervisor.ts")
      .flatMap((file) =>
        fs.readFileSync(file, "utf8").includes(oldRelayProtectedHelper)
          ? [path.relative(serverSrc, file)]
          : [],
      )
    expect(oldHelperReferences).toEqual([])
  })

  test("keeps session persistence on driver terminology", () => {
    const cloudSchema = fs.readFileSync(path.resolve(import.meta.dirname, "storage/cloud-session.sql.ts"), "utf8")
    const terminalSchema = fs.readFileSync(path.resolve(import.meta.dirname, "storage/terminal-session.sql.ts"), "utf8")
    const sync = fs.readFileSync(path.resolve(import.meta.dirname, "cloud/session-sync.ts"), "utf8")

    expect(cloudSchema).toContain("driver: text()")
    expect(cloudSchema).not.toContain("provider: text()")
    expect(terminalSchema).toContain("driver: text()")
    expect(terminalSchema).not.toContain("provider: text()")
    expect(sync).not.toContain("provider: row.driver")
    expect(sync).not.toContain("provider: workspaceDriver")
  })

  test("keeps retired supervisor runtime entrypoint names deleted", () => {
    const serverSrc = path.resolve(import.meta.dirname)
    const retired = [
      "ensure" + "WorkspaceRuntime",
      "ensureRelayProtected" + "WorkspaceRuntime",
      "sync" + "WorkspaceRuntime(",
      "list" + "WorkspaceRuntimes",
      "get" + "WorkspaceSandboxTarget",
      "touch" + "WorkspaceRuntimeHost",
      "get" + "WorkspaceRuntimeStatus",
      "discard" + "WorkspaceRuntime",
      "mark" + "RuntimeUse",
      "hold" + "Runtime",
      "release" + "Runtime",
      "stop" + "Runtime(",
    ]
    const offenders = walk(serverSrc)
      .filter((file) => file.endsWith(".ts"))
      .flatMap((file) => {
        const text = fs.readFileSync(file, "utf8")
        return retired
          .filter((term) => text.includes(term))
          .map((term) => `${path.relative(serverSrc, file)}:${term}`)
      })

    expect(offenders).toEqual([])
  })

  test("keeps remaining legacy cloud-host compatibility terms auditable", () => {
    const serverSrc = path.resolve(import.meta.dirname)
    const appSrc = path.resolve(serverSrc, "../../claxedo-app/src")
    const productionFiles = walk(serverSrc)
      .filter((file) => file.endsWith(".ts") || file.endsWith(".mjs"))
      .filter((file) => !file.endsWith(".test.ts"))
      .map((file) => path.relative(serverSrc, file))
      .sort()

    const filesContaining = (term: string) =>
      productionFiles.filter((file) => fs.readFileSync(path.resolve(serverSrc, file), "utf8").includes(term))
    const filesMatching = (pattern: RegExp) =>
      productionFiles.filter((file) => pattern.test(fs.readFileSync(path.resolve(serverSrc, file), "utf8")))
    const appFilesContaining = (term: string) =>
      walk(appSrc)
        .filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"))
        .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".vitest.tsx"))
        .map((file) => path.relative(appSrc, file))
        .filter((file) => fs.readFileSync(path.resolve(appSrc, file), "utf8").includes(term))
        .sort()

    expect(filesContaining("ensure" + "WorkspaceRuntime")).toEqual([])
    expect(filesContaining("mark" + "RuntimeUse")).toEqual([])
    expect(filesContaining("hold" + "Runtime")).toEqual([])
    expect(filesContaining("release" + "Runtime")).toEqual([])
    expect(filesContaining("stop" + "Runtime(")).toEqual([])
    expect(filesContaining("sandbox_url")).toEqual([])
    expect(filesContaining("runtime_" + "url")).toEqual([
      "storage/workspace-lease.sql.ts",
    ])
    expect(filesContaining("accel_" + "runtime_snapshot_id")).toEqual(["storage/workspace-lease.sql.ts"])
    expect(filesContaining("runtime-host")).toEqual([])
    expect(filesContaining("cloud/lifecycle")).toEqual(["architecture-ownership.ts"])
    expect(filesContaining("cloud/sandbox")).toEqual(["architecture-ownership.ts"])
    expect(filesContaining("RuntimeProvider")).toEqual([])
    expect(filesContaining("RuntimeLifecycle")).toEqual(["architecture-ownership.ts"])
    expect(filesContaining("RuntimeHost")).toEqual([])
    expect(filesContaining("runtimeHost")).toEqual([])
    expect(filesContaining("runtimeLeases")).toEqual([])
    expect(filesContaining("ControlPlaneRuntimeHost")).toEqual([])
    expect(filesContaining("createRuntimeHostManager")).toEqual([])
    expect(filesContaining("services.runtimeHost")).toEqual([])
    expect(filesContaining("options.runtimeHost")).toEqual([])
    expect(filesContaining("RuntimeHostDriver")).toEqual([])
    expect(filesContaining("RuntimeHostTarget")).toEqual([])
    expect(filesContaining("RuntimeHostEnsureHostInput")).toEqual([])
    expect(filesContaining("RuntimeHostEnsureResult")).toEqual([])
    expect(filesContaining("RuntimeHostSnapshotResult")).toEqual([])
    expect(filesContaining("RuntimeHostTargetResult")).toEqual([])
    expect(filesMatching(/\bRUNTIME_PORT\b/)).toEqual([])
    expect(filesMatching(/\bDEFAULT_RUNTIME_PORT\b/)).toEqual([])
    expect(filesContaining("RuntimeHostProvider")).toEqual([])
    expect(filesContaining("runtimeHostProvider")).toEqual([])
    expect(filesContaining("defaultRuntimeHostProvider")).toEqual([])
    expect(filesContaining("hasRuntimeHostProvider")).toEqual([])
    expect(filesContaining("SandboxProvider")).toEqual([])
    expect(filesContaining("SandboxHandle")).toEqual([])
    expect(filesContaining("SandboxProviderID")).toEqual([])
    expect(filesContaining("SandboxConfig")).toEqual([])
    expect(filesContaining("sandbox_provider_ids")).toEqual([])
    expect(filesContaining("defaultSandboxProvider")).toEqual([])
    expect(filesContaining("hasSandboxAuth")).toEqual([])
    expect(filesContaining("default_" + "provider")).toEqual([])
    expect(filesContaining("../../sandbox-manager/src/provider-catalog")).toEqual([])
    expect(filesContaining("../../sandbox-manager/src/provider-auth")).toEqual([])
    expect(filesContaining("provider_" + "object_id")).toEqual(["storage/repair.ts"])
    expect(filesContaining("provider_" + "snapshot_id")).toEqual(["storage/repair.ts"])
    expect(filesContaining("provider" + "ObjectId")).toEqual([])
    expect(filesContaining("provider" + "SnapshotId")).toEqual([])
    expect(filesContaining("provider_" + "runtime_id")).toEqual([])
    expect(filesContaining("provider-" + "snapshot")).toEqual([])
    expect(filesContaining("provider-" + "service-url")).toEqual([])
    expect(filesContaining("provider-" + "authenticated")).toEqual([])
    expect(filesContaining("WORKSPACE_RUNTIME_SERVICE_EXPOSURE_" + "PROVIDER")).toEqual([])
    expect(filesContaining("CLAXEDO_RUNTIME_" + "PROVIDER")).toEqual([])
    expect(filesContaining("cloud_" + "provider_unavailable")).toEqual([])
    expect(filesContaining("hosted_runtime_" + "provider_unsupported")).toEqual([])
    expect(filesContaining("/internal/runtime")).toEqual([])
    expect(filesContaining("hosted-runtime-admin")).toEqual([])
    expect(filesContaining("HostedRuntimeAdminRoutes")).toEqual([])
    expect(filesContaining("runtime_admin_")).toEqual([])
    expect(filesContaining("runtime_host_manager_unavailable")).toEqual([])
    expect(filesContaining("runtime_host_unavailable")).toEqual([])
    expect(filesContaining("runtime_host_driver_unavailable")).toEqual([])
    expect(filesContaining("runtime host manager unavailable")).toEqual([])
    expect(filesContaining("workspace runtime host manager unavailable")).toEqual([])
    expect(filesContaining("runtime_host.garbage_collect")).toEqual([])
    expect(filesContaining("runtime_host.release")).toEqual([])
    expect(filesContaining("pending_sandbox")).toEqual([])
    expect(appFilesContaining("pending_sandbox")).toEqual([])
    expect(appFilesContaining("environment?.provider")).toEqual([])
    expect(appFilesContaining("environment?: { kind?: string; driver?: string; provider?: string }")).toEqual([])
    expect(appFilesContaining("provider: txt(workspace?.backing")).toEqual([])
    expect(appFilesContaining("provider: txt(row?.backing")).toEqual([])

    const convexSrc = path.resolve(serverSrc, "../../../convex")
    const convexFiles = walk(convexSrc)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => path.relative(convexSrc, file))
      .sort()
    const convexFilesContaining = (term: string) =>
      convexFiles.filter((file) => fs.readFileSync(path.resolve(convexSrc, file), "utf8").includes(term))
    expect(convexFiles).not.toContain("runtimeLeases.ts")
    expect(convexFilesContaining("provider_" + "runtime_id")).toEqual(["sandboxLeases.ts"])
    expect(convexFilesContaining("provider_" + "snapshot_id")).toEqual([])
    // migrations.ts names the table because migration #001 (D14) is the
    // retro-registered runtime_leases legacy-field backfill; the normalize
    // LOGIC still lives only in sandboxLeases.ts (imported helpers).
    expect(convexFilesContaining("runtime_" + "leases")).toEqual(["migrations.ts", "sandboxLeases.ts", "schema.ts"])
    expect(convexFilesContaining("runtime_" + "url")).toEqual(["sandboxLeases.ts", "schema.ts"])
    const convexSandboxLeases = fs.readFileSync(path.resolve(convexSrc, "sandboxLeases.ts"), "utf8")
    expect(convexSandboxLeases).toContain("export const normalizeLegacyFields")
    expect(convexSandboxLeases).toContain("canonicalLeaseDocument")

    const workspaceRuntimeSrc = path.resolve(serverSrc, "../../workspace-runtime/src")
    const workspaceRuntimeProductionFiles = walk(workspaceRuntimeSrc)
      .filter((file) => file.endsWith(".ts"))
      .filter((file) => !file.endsWith(".test.ts"))
      .map((file) => path.relative(workspaceRuntimeSrc, file))
      .sort()
    const workspaceRuntimeFilesContaining = (term: string) =>
      workspaceRuntimeProductionFiles.filter((file) => fs.readFileSync(path.resolve(workspaceRuntimeSrc, file), "utf8").includes(term))
    expect(workspaceRuntimeFilesContaining("provider-" + "service-url")).toEqual([])
    expect(workspaceRuntimeFilesContaining("provider-" + "authenticated")).toEqual([])
    expect(workspaceRuntimeFilesContaining("WORKSPACE_RUNTIME_SERVICE_EXPOSURE_" + "PROVIDER")).toEqual([])

    const runtimeHostProviderNamedFiles = walk(path.resolve(serverSrc, "../../sandbox-manager/src"))
      .filter((file) => path.basename(file).startsWith("provider-"))
      .map((file) => path.relative(serverSrc, file))
      .sort()
    expect(runtimeHostProviderNamedFiles).toEqual([])

    const supervisorRuntimeHost = fs.readFileSync(
      path.resolve(serverSrc, "workspace-supervisor-sandbox.ts"),
      "utf8",
    )
    expect(supervisorRuntimeHost).not.toContain("Runtime host provider")
    expect(supervisorRuntimeHost).not.toContain("provider:")
    expect(supervisorRuntimeHost).not.toContain("runtime_host_target")

    const supervisorStore = fs.readFileSync(path.resolve(serverSrc, "workspace-supervisor-store.ts"), "utf8")
    expect(supervisorStore).not.toContain("runtime_host_target")
    expect(supervisorStore).toContain("sandbox_target")

    const supervisorRuntimeEnv = fs.readFileSync(
      path.resolve(serverSrc, "workspace-supervisor-runtime-env.ts"),
      "utf8",
    )
    expect(supervisorRuntimeEnv).not.toContain("provider: SandboxDriverID")
    expect(supervisorRuntimeEnv).not.toContain("relayJwksUrl(provider")
    expect(supervisorRuntimeEnv).not.toContain("sandboxReachableUrl(provider")

    const sandboxDriverRoutes = fs.readFileSync(
      path.resolve(serverSrc, "routes/sandbox-driver-routes.ts"),
      "utf8",
    )
    expect(sandboxDriverRoutes).not.toContain("\"/providers")
    expect(sandboxDriverRoutes).not.toContain("body.provider")
    expect(sandboxDriverRoutes).toContain("\"/drivers")
    expect(sandboxDriverRoutes).toContain("function putSandboxDriverCredential")
    expect(sandboxDriverRoutes).toContain("provider_id: driverId")

    const workspaceRoutes = fs.readFileSync(path.resolve(serverSrc, "routes/workspace.ts"), "utf8")
    expect(workspaceRoutes).not.toContain("body.driver ?? body.provider")
    expect(workspaceRoutes).not.toContain("provider: z.string().optional()")

    const workspaceStore = fs.readFileSync(path.resolve(serverSrc, "workspace-store.ts"), "utf8")
    expect(workspaceStore).not.toContain("provider?: SandboxDriverID")
    expect(workspaceStore).not.toContain("item.driver ?? item.provider")

    const convexLeaseStore = fs.readFileSync(path.resolve(serverSrc, "sandbox-manager-adapters/stores/convex.ts"), "utf8")
    expect(convexLeaseStore).not.toContain("provider?:")
    expect(convexLeaseStore).not.toContain("provider_runtime_id")
    expect(convexLeaseStore).not.toContain("row.provider")

    const sessionList = fs.readFileSync(path.resolve(serverSrc, "session-list.ts"), "utf8")
    expect(sessionList).not.toContain("environment.provider")
    expect(sessionList).not.toContain("provider:${row.environment")
  })

  test("keeps old sandbox credential kind names confined to the one-time migration", () => {
    const packageRoot = path.resolve(import.meta.dirname, "..")
    const files = walk(packageRoot)
      .filter((file) => file.endsWith(".ts") || file.endsWith(".sql"))
      .filter((file) => path.relative(packageRoot, file) !== "src/architecture.test.ts")
      .map((file) => path.relative(packageRoot, file))
      .sort()
    const filesContaining = (term: string) =>
      files.filter((file) => fs.readFileSync(path.resolve(packageRoot, file), "utf8").includes(term))

    expect(filesContaining("sandbox_" + "provider")).toEqual([
      "src/storage/claxedo-migration/20260702000100_sandbox_driver_credentials/migration.sql",
      "src/storage/repair.test.ts",
    ])
    expect(filesContaining("runtime_" + "host_provider")).toEqual([
      "src/storage/claxedo-migration/20260702000100_sandbox_driver_credentials/migration.sql",
      "src/storage/repair.test.ts",
    ])
  })

  test("keeps server route modules mounted or explicitly accounted for", () => {
    const routeFiles = fs
      .readdirSync(path.resolve(import.meta.dirname, "routes"))
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .sort()

    expect(routeFiles).toEqual([
      "agent-config-command-routes.ts",
      "agent-config-extension-routes.ts",
      "agent-config-extension-support.ts",
      "agent-config-harness-routes.ts",
      "agent-config-harness.ts",
      "agent-config-local-auth.ts",
      "agent-config-mcp-routes.ts",
      "agent-config.ts",
      "bootstrap.ts",
      "credential.ts",
      "events.ts",
      // Hosted (Cloudflare Worker) control-plane routes. Mounted by hosted-app.ts
      // (the Worker entrypoint), NOT by the local Node server.ts. See
      // docs/tech-docs/claxedo-server-worker-deployment-plan.md.
      "hosted-control.ts",
      "hosted-device-auth.ts",
      "hosted-sandbox-admin.ts",
      // Minimal hosted shell-boot surface (events SSE, /global/health,
      // /api/claxedo/bootstrap, /project, /project/current, /path, /provider)
      // so the app shell boots against a hosted central with no local runner.
      "hosted-shell.ts",
      "hosted-workspace.ts",
      "http.ts",
      // Node-only disk-backed relay target lookups injected into the shared
      // internal-relay route from server.ts (keeps workspace-store out of the
      // Worker graph).
      "internal-relay-local.ts",
      "internal-relay.ts",
      "living-apps.ts",
      "local-only-projection.ts",
      "network-policy.ts",
      "opencode-compat-context.ts",
      "opencode-compat-events.ts",
      "opencode-compat-file-browser.ts",
      "opencode-compat-files.ts",
      "opencode-compat-git.ts",
      "opencode-compat-provider-config.ts",
      "opencode-compat-proxy.ts",
      "opencode-compat-worktree-routes.ts",
      "opencode-compat-worktree.ts",
      "opencode-compat.ts",
      "page-arena-events.ts",
      "page-arena-format.ts",
      "page-arena-opencode.ts",
      "page-arena-runtime.ts",
      "page-arena-settings.ts",
      "page-arena-state.ts",
      "page-arena-store.ts",
      "page-arena-wave-runner.ts",
      "page-content.ts",
      "page-store.ts",
      "pages-arena.ts",
      "pages.ts",
      "provider-auth.ts",
      "sandbox-driver-routes.ts",
      "session-meta.ts",
      "workspace-cloud-connection.ts",
      "workspace-connection-routes.ts",
      "workspace-git.ts",
      "workspace-hosted-connection-info.ts",
      "workspace-local-host-link-routes.ts",
      "workspace-local-host.ts",
      "workspace-route-support.ts",
      "workspace-runtime-token-guards.ts",
      "workspace-share-routes.ts",
      "workspace-signed-access.ts",
      "workspace-user-hosted-connection.ts",
      // Compatibility barrel for shared workspace connection helpers.
      "workspace-user-hosted.ts",
      "workspace.ts",
    ])

    const server = fs.readFileSync(path.resolve(import.meta.dirname, "server.ts"), "utf-8")
    const pages = fs.readFileSync(path.resolve(import.meta.dirname, "routes/pages.ts"), "utf-8")
    const serverWorkgraph = fs.readFileSync(path.resolve(import.meta.dirname, "server-workgraph.ts"), "utf-8")

    for (const token of [
      "JwksRoutes(process.env)",
      "InternalRelayResolverRoutes(",
      "BootstrapRoutes(",
      "ProviderAuthRoutes(",
      "OpenCodeCompatRoutes(",
      "workspaceRuntimeProxy",
      "PagesRoutes({",
      "AgentConfigRoutes(",
      "SessionMetaRoutes(",
      "WorkspaceRoutes(",
      "createCentralControlApp(",
      "CredentialRoutes(",
      "NetworkPolicyRoutes(",
      "LivingAppsRoutes()",
      "eventsHandler",
      "mountLazyEmbeddedWorkGraph(",
    ]) {
      expect(server).toContain(token)
    }
    expect(serverWorkgraph).not.toContain("localOnlyProjection(")
    expect(pages).toContain("authorizePage:")
    expect(pages).toContain("PageArenaRoutes(arenaOptions)")
  })

  test("keeps API error response bodies structured", () => {
    const files = [
      path.resolve(import.meta.dirname, "server.ts"),
      path.resolve(import.meta.dirname, "proxy.ts"),
      ...walk(path.resolve(import.meta.dirname, "routes")).filter((file) => file.endsWith(".ts")),
    ]
    const rawScalarErrorBodies = files.flatMap((file) => {
      const text = fs.readFileSync(file, "utf-8")
      return [...text.matchAll(/(?:c\.json|Response\.json)\(\s*\{\s*(?:error|message):\s*["'`]/g)].map(
        (match) => `${path.relative(import.meta.dirname, file)}:${match.index}`,
      )
    })

    expect(rawScalarErrorBodies).toEqual([])
  })

  test("keeps Agent Extension install on the package-owned canonical materializer", () => {
    const serverInstall = fs.readFileSync(path.resolve(import.meta.dirname, "agent-extensions/install.ts"), "utf-8")
    const packageInstall = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../agent-extensions/src/install.ts"),
      "utf-8",
    )

    expect(packageInstall).toContain("materializeAgentExtensionSnapshot")
    expect(serverInstall).toContain("@claxedo/agent-extensions")
    expect(serverInstall).toContain("fanOutConfig")
    expect(serverInstall).not.toContain("materializeAgentExtensionSnapshot")
    expect(serverInstall).not.toContain("applyRuntimeAgentExtensions")
    expect(serverInstall).not.toContain("agent-extensions/replay")
  })

  test("keeps generic Agent Extension lifecycle code out of claxedo-server", () => {
    const root = path.resolve(import.meta.dirname, "agent-extensions")
    const forbidden = ["cache.ts", "fetch.ts", "manifest.ts", "source.ts", "state.ts", "lock.ts", "storage.ts"]

    expect(forbidden.filter((file) => fs.existsSync(path.join(root, file)))).toEqual([])
  })

  test("keeps server Agent Extension orchestration away from runtime replay", () => {
    const files = walk(path.resolve(import.meta.dirname, "agent-extensions")).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
    )
    const replayImports = files.flatMap((file) => {
      const text = fs.readFileSync(file, "utf-8")
      return text.includes("applyRuntimeAgentExtensions") || text.includes("@claxedo/agent-extensions/replay")
        ? [path.relative(import.meta.dirname, file)]
        : []
    })

    expect(replayImports).toEqual([])
  })

  test("keeps package Agent Extension lifecycle modules free of server dependencies", () => {
    const root = path.resolve(import.meta.dirname, "../../agent-extensions/src")
    const lifecycleFiles = [
      "cache.ts",
      "facade.ts",
      "fetch.ts",
      "install.ts",
      "manifest.ts",
      "runtime-config.ts",
      "source.ts",
      "state.ts",
      "lock.ts",
      "storage.ts",
      "workspace.ts",
    ]
    const forbidden = ["../paths", "config-fanout", "workspace-supervisor", "ControlPlane", "Convex", "Hono"]
    const leaks = lifecycleFiles.flatMap((file) => {
      const text = fs.readFileSync(path.join(root, file), "utf-8")
      return forbidden.flatMap((term) => (text.includes(term) ? [`${file}:${term}`] : []))
    })

    expect(leaks).toEqual([])
  })

  test("keeps workspace access routes free of ambient env configuration", () => {
    const workspace = fs.readFileSync(path.resolve(import.meta.dirname, "routes/workspace.ts"), "utf-8")
    const internalRelay = fs.readFileSync(path.resolve(import.meta.dirname, "routes/internal-relay.ts"), "utf-8")
    const bootstrap = fs.readFileSync(path.resolve(import.meta.dirname, "routes/bootstrap.ts"), "utf-8")
    const opencodeCompat = fs.readFileSync(path.resolve(import.meta.dirname, "routes/opencode-compat.ts"), "utf-8")
    const jwks = fs.readFileSync(path.resolve(import.meta.dirname, "control-plane/routes/jwks.ts"), "utf-8")
    const pagesArena = fs.readFileSync(path.resolve(import.meta.dirname, "routes/pages-arena.ts"), "utf-8")
    const embeddedRuntime = fs.readFileSync(path.resolve(import.meta.dirname, "embedded-workspace-runtime.ts"), "utf-8")
    const opencodeMcpSync = fs.readFileSync(path.resolve(import.meta.dirname, "opencode-mcp-sync.ts"), "utf-8")
    const agentConfig = fs.readFileSync(path.resolve(import.meta.dirname, "agent-config.ts"), "utf-8")
    const controlPlaneServices = fs.readFileSync(
      path.resolve(import.meta.dirname, "control-plane/services.ts"),
      "utf-8",
    )
    const server = fs.readFileSync(path.resolve(import.meta.dirname, "server.ts"), "utf-8")

    expect(workspace).not.toContain("process.env")
    expect(internalRelay).not.toContain("process.env")
    expect(bootstrap).not.toContain("process.env")
    expect(opencodeCompat).not.toContain("process.env")
    expect(jwks).not.toContain("process.env")
    expect(pagesArena).not.toContain("process.env")
    expect(embeddedRuntime).not.toContain("process.env")
    expect(opencodeMcpSync).not.toContain("process.env")
    expect(agentConfig).not.toContain("process.env.CLAXEDO_ACP_DIR")
    expect(controlPlaneServices).not.toContain("process.env.CONVEX_URL")
    expect(controlPlaneServices).not.toContain("process.env.CLAXEDO_CONVEX_URL")
    expect(server).toContain("function localRelayFromEnv(sandboxManager = createWorkspaceSupervisorSandboxManager())")
    expect(server).toContain("relay: localRelayFromEnv(sandboxManager)")
    expect(server).toContain("env: process.env")
    expect(server).toContain("PagesRoutes({")
    expect(server).toContain("services,")
    expect(server).toContain("...authRouteOptions(services)")
    expect(server).toContain("configureOpencodeMcpSync({ enabled: opencodeCompat })")
    expect(server).toContain("configureEmbeddedWorkspaceRuntime({")
    expect(server).toContain('const opencodeCompat = process.env.CLAXEDO_DISABLE_OPENCODE_COMPAT !== "1"')
    expect(server).toContain("configureAgentConfig({")
    expect(server).toContain("const authorityUrl = convexAuthorityUrlFromEnv(process.env)")
    expect(server).toContain("? createConvexAuthority({ url: authorityUrl })")
    expect(server).toContain(": createSqliteWorkspaceAuthority(),")
    expect(server).toContain("JwksRoutes(process.env)")
  })

  test("keeps command compatibility mounted in one place", () => {
    const agentConfig = fs.readFileSync(path.resolve(import.meta.dirname, "routes/agent-config.ts"), "utf-8")
    const opencodeCompat = fs.readFileSync(path.resolve(import.meta.dirname, "routes/opencode-compat.ts"), "utf-8")
    const sessionRoutes = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../workspace-runtime/src/routes/session-core.ts"),
      "utf-8",
    )

    expect(agentConfig).not.toContain("createCommandCompatRoutes")
    expect(opencodeCompat).toContain('.get("/command"')
    expect(sessionRoutes).toContain("exposeCommandRoute")
    expect(sessionRoutes).toContain('.get("/command"')
  })

  test("keeps experimental session inventory owned by the sandbox", () => {
    const opencodeCompat = fs.readFileSync(path.resolve(import.meta.dirname, "routes/opencode-compat.ts"), "utf-8")
    const routeOwnership = fs.readFileSync(path.resolve(import.meta.dirname, "route-ownership.ts"), "utf-8")
    const sessionRoutes = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../workspace-runtime/src/routes/session-core.ts"),
      "utf-8",
    )

    expect(opencodeCompat).not.toContain("listLocalSessions")
    expect(opencodeCompat).not.toContain('.get("/experimental/session"')
    expect(routeOwnership).toContain('exact(["/experimental/session"], RouteDomain.AgentSessionRuntime, runtime)')
    expect(sessionRoutes).toContain('.get("/experimental/session"')
  })

  test("keeps WorkGraph out of Control Plane module load", () => {
    const server = fs.readFileSync(path.resolve(import.meta.dirname, "server.ts"), "utf-8")
    const serverWorkgraph = fs.readFileSync(path.resolve(import.meta.dirname, "server-workgraph.ts"), "utf-8")

    expect(server).not.toMatch(/from ["']@claxedo\/workgraph["']/)
    expect(server).not.toMatch(/from ["']\.\/workgraph-execution["']/)
    expect(serverWorkgraph).not.toMatch(/^import (?!type\b).*from ["']@claxedo\/workgraph["']/m)
    expect(serverWorkgraph).not.toMatch(/from ["']\.\/workgraph-execution["']/)
    expect(serverWorkgraph).toContain('import("@claxedo/workgraph")')
    expect(server).toContain('import("./workgraph-session-gateway")')
  })
})
