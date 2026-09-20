// Static runtime ownership rules. Behavioral assertions live with their owners.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { prodSourcePaths } from "@/architecture/scanners"
import { can, RolePolicy } from "@/platform/auth/role"
import type { Placement, RelayRole } from "@/platform/runtime/placement"
import { sameSessionIdentity } from "@/platform/sync/global-session-identity"

const root = path.resolve(import.meta.dir, "../..")
// Files allowed to call /api/claxedo/{pty,process,diff} directly via
// fetch (instead of through process/client.ts). Each entry should have
// a comment explaining why direct fetch is justified (or a follow-up
// to migrate to the canonical client).
const allowed = new Set([
  "process/client.ts",
  "features/terminal/ui/terminal.tsx",
  "features/terminal/providers/provider.tsx",
  "features/terminal/core/terminal-connection.ts",
])

const runtimeGatewayBoundary = new Set([
  "platform/runtime/agent/workspace-relay-connection.ts",
  "platform/runtime/agent/workspace-runtime-request.ts",
  "platform/runtime/agent/agent-runtime-urls.ts",
  "platform/api/credential-request.ts",
  "app/connection/server-health.ts",
  "features/workspaces/data/share-workspace.ts",
  "platform/runtime/agent/workspace-control-routes.ts",
  // The sandbox-driver path literals `workspace-control-routes.ts` builds its
  // URLs from, split into an import-free module so claxedo-server's
  // `sandbox-driver-routes.contract.test.ts` can dispatch them through the real
  // Hono router. Same route-boundary role, bindable from the server side.
  "platform/runtime/agent/workspace-control-paths.ts",
  "platform/runtime/agent/dialog-select-directory-routes.ts",
  "app/workbench/state/route-bridge.tsx",
  // Pure route→session resolution and session-probe URL builders; the same
  // route-boundary role as route-bridge.tsx.
  "app/workbench/state/route-bridge-resolution.ts",
  "features/session/data/sync/inventory-source.ts",
  "platform/runtime/transport.ts",
  "app/boot/data/bootstrap.ts",
  "features/session/composer/ui/submit-transport.ts",
  "features/session/harness/harness-config-runtime.ts",
  // Cross-feature provider query adapter owns the explicit harness-scoped
  // provider route used by settings and session model selectors.
  "platform/query/control-plane.ts",
  // AccountPort fetch adapters are transport boundaries: they parse legacy
  // browser URLs and translate them into named desktop operations.
  "platform/account/control-plane-account-fetch.ts",
])

const workspaceRuntimeIdentityBoundary = new Set([
  ...runtimeGatewayBoundary,
  "platform/identity/legacy-resolver.ts",
  "platform/runtime/agent/agent-runtime-client.ts",
  // Pure session-routing decision table; the same runtime-identity boundary
  // role as agent-runtime-client.ts, and re-exports workspaceIdFromRef.
  "platform/runtime/agent/placement-table.ts",
  "platform/runtime/session-workspace.ts",
  "platform/runtime/workspace-runtime-record.ts",
])

const workspaceSelectorSyntaxBoundary = new Set([
  ...workspaceRuntimeIdentityBoundary,
  "architecture/scanners.ts",
  "platform/sync/worktree.ts",
  // Imports the canonical workspaceIdFromRef directly.
  "platform/runtime/placement.ts",
  "features/workspaces/ui/panel/workspace-panel.tsx",
  // A draft's workspace-backing resolution short-circuits the async
  // `runtime.workspace()` liveness read when the directory isn't even
  // `ws_`/`workspace:`-shaped, so it checks the raw ref shape itself before
  // paying for that round trip.
  "features/session/harness/harness-hydrator.ts",
])

const sessionStatusBoundary = new Set([
  "features/session/store/session-status-dispatcher.ts",
  "features/session/data/sync/queries.ts",
])

const legacyConversationCleanupBoundary = new Set(["features/session/data/sync/session-cache-cleanup.ts"])

const routeParamBoundary = new Set([
  "app/app-shell.tsx", // route-to-Workbench bridge and URL mirroring
  "app/routes/directory-layout.tsx", // route entry resolves directory provider scope
  "app/workbench/state/route-bridge.tsx", // route-to-state bridge owns params
  "features/session/ui/dialogs/fork.tsx",
  "platform/comments/provider.tsx",
  "features/session/providers/permission.tsx",
])

const sessionRenderBoundary = new Set(["features/session/ui/content/session-content.tsx"])

const sessionRefHostOwnerBoundary = new Set(["platform/identity/session-ref.ts"])

const platformContext = "platform/runtime/platform-provider.tsx"
const sessionContextTab = "features/session/ui/components/session-context-tab.tsx"
const sessionCommandsHook = "features/session/ui/use-session-commands.tsx"
const syncContext = "overrides/context/sync.tsx"
const languageContext = "platform/i18n/provider.tsx"
const homePage = "app/routes/home.tsx"
const sessionPage = "features/session/ui/session-screen.tsx"
const sessionTimeline = "features/session/ui/message-timeline.tsx"
const sessionController = "features/session/store/session-controller.ts"
const sessionComposer = "features/session/ui/composer/index.ts"
const sessionComposerRegion = "features/session/ui/composer/session-composer-region.tsx"
const sessionComposerState = "features/session/ui/composer/session-composer-state.ts"
const upstreamSessionComposerRegion = "features/session/ui/composer/session-composer-region.tsx"
const globalSyncContext = "app/providers/global-sync/provider.tsx"
const sessionListEvents = "features/session/data/sync/session-list-events.ts"
const directoryScope = "app/workbench/context/directory-scope.tsx"
const dialogSelectFile = "features/session/ui/dialogs/select-file.tsx"
const sessionHeader = "features/session/ui/components/session-header.tsx"
const promptInput = "features/session/composer/composer.tsx"
const promptSubmit = "features/session/composer/ui/submit.ts"
const promptSubmitInput = "features/session/composer/ui/submit-input.ts"
const promptSubmitPending = "features/session/submit/pending.ts"
const promptSubmitSend = "features/session/submit/send.ts"
const promptSubmitTypes = "features/session/submit/types.ts"
const terminalComponent = "features/terminal/ui/terminal.tsx"
const terminalContext = "features/terminal/providers/provider.tsx"
const roleGuardedTerminal = "features/terminal/core/role-guarded-terminal.tsx"
const reviewTab = "features/review/ui/review-tab.tsx"
const harnessConfigStore = "features/session/harness/harness-config-store.ts"
const appShellLayout = "app/app-shell-layout.tsx"
const railSidebarShell = "app/workbench/rail/rail-sidebar-shell.tsx"
const railWorkbenchShell = "app/workbench/rail/rail-workbench-shell.tsx"
const railSidebar = "app/workbench/rail/rail-sidebar.tsx"
const layoutContext = "app/providers/layout.tsx"
const dialogEditProject = "features/workspaces/ui/dialog-edit-project.tsx"
const appShellState = "app/app-shell-state.ts"
const appShellRouteSync = "app/app-shell-route-sync.ts"
const claxedoSessionActions = "features/session/actions/session-actions.tsx"
const directorySessionCache = "features/session/data/sync/directory-session-cache.ts"
const notificationContext = "app/providers/notification.tsx"
const localContextOwner = "features/session/providers/session-selection.tsx"
const settingsSandboxSection = "features/settings/ui/sandbox-section.tsx"
const networkPolicySettings = "features/settings/ui/network-policy.tsx"
// The connect flow and provider catalog live outside the dialogs so the
// onboarding setup page renders the same surfaces; the dialogs are shells, so
// these invariants target the files that hold the logic.
const dialogConnectProvider = "app/dialogs/provider-connect-form.tsx"
const promptModelStrategy = "features/session/composer/model-strategy.ts"
const promptToolbarState = "features/session/composer/toolbar-state.ts"
const contentRenderers = [
  "app/workbench/content/context-content.tsx",
  "features/documents/ui/content/page-content.tsx",
  "features/session/ui/content/session-content.tsx",
  "features/terminal/ui/content/terminal-content.tsx",
]
const projectInventoryContentRenderers = ["features/documents/ui/content/pages-index-content.tsx"]
const sessionPaneScope = "features/session/ui/components/session-pane-scope.tsx"

async function files(dir: string): Promise<string[]> {
  return prodSourcePaths(path.dirname(dir))
    .map((file) => canonicalRelativePath(path.relative(dir, file)))
}

function canonicalRelativePath(value: string): string {
  return value.replaceAll("\\", "/")
}

// Route-literal scans must read code, not prose. Comments legitimately name
// endpoints they document the removal of (e.g. the retired `/documents/events`
// SSE), and a bare text scan reports those as boundary violations.
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
}

async function upstreamAppText(file: string) {
  return await Bun.file(path.join(root, file)).text()
}

describe("workspace runtime route audit", () => {
  test("discovered source paths use one platform-independent allowlist shape", () => {
    expect(canonicalRelativePath("features\\session\\data\\sync.ts")).toBe("features/session/data/sync.ts")
    expect(canonicalRelativePath("features/session/data/sync.ts")).toBe("features/session/data/sync.ts")
  })

  test("structural performance invariants are part of the package typecheck gate", async () => {
    const pkg = (await Bun.file(path.resolve(root, "..", "package.json")).json()) as {
      scripts?: Record<string, string>
    }

    expect(pkg.scripts?.typecheck).toContain("bun run test:performance")

    // Structural scenarios the perf gate is expected to cover. Each one is
    // checked twice: that `test:performance` still names it (catches silent
    // removal from the gate) and that the file still exists (catches a rename
    // that leaves the script pointing at a path that no longer resolves).
    const scenarios = [
      "src/features/session/ui/message-timeline-row-reuse.test.ts",
      "src/app/workbench/context/directory-scope.vitest.tsx",
      "src/app/workbench/workbench/tests/F-mount-retention.vitest.tsx",
      "src/app/workbench/workbench/tests/N-reactivity.vitest.tsx",
    ]
    const missing: string[] = []
    for (const scenario of scenarios) {
      expect(pkg.scripts?.["test:performance"]).toContain(path.basename(scenario))
      if (!(await Bun.file(path.resolve(root, "..", scenario)).exists())) missing.push(scenario)
    }
    expect(missing).toEqual([])
  })

  test("UI code does not call Workspace Host runtime routes through claxedo-server directly", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (allowed.has(file)) continue
      const text = await Bun.file(path.join(root, file)).text()
      if (/claxedoServerUrl\}\/api\/claxedo\/(?:pty|process|diff)/.test(text)) offenders.push(file)
      if (/getClaxedoServerUrl\(\)\}\/api\/claxedo\/(?:pty|process|diff)/.test(text)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  test("production code builds workspace runtime requests only through transport boundaries", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (runtimeGatewayBoundary.has(file)) continue
      const text = await Bun.file(path.join(root, file)).text()
      for (const match of text.matchAll(
        /(?:import|export)\s+\{\s*([^}]+)\s*\}\s+from\s+["'][^"']*workspace-runtime-request["']/g,
      )) {
        const unsafe = match[1]
          .split(",")
          .map((item) => item.trim().replace(/\s+as\s+\w+$/, ""))
          .filter(
            (item) => item !== "workspaceIdFromDirectoryRef" || !workspaceRuntimeIdentityBoundary.has(file),
          )
        if (unsafe.length > 0)
          offenders.push(`${file}: imports/exports ${unsafe.join(", ")} from workspace-runtime-request`)
      }
    }
    // Runtime-ref normalization (`runtimeScope()` and `sessionWorkspaceRuntimeRef`)
    // lives in the record reader in `@claxedo/app`; the hosted startup module
    // calls it. Both halves are asserted so neither file can re-derive the ref.
    const runtimeRecord = await Bun.file(path.join(root, "platform/runtime/workspace-runtime-record.ts")).text()
    const runtimeStore = await Bun.file(path.join(root, "platform/runtime/cloud/workspace-runtime-store.ts")).text()
    const agentRuntimeClient = await Bun.file(path.join(root, "platform/runtime/agent/agent-runtime-client.ts")).text()
    const httpBackend = await Bun.file(path.join(root, "platform/runtime/http-backend.ts")).text()
    const globalSync = await Bun.file(path.join(root, globalSyncContext)).text()
    const globalSyncBootstrap = await Bun.file(path.join(root, "app/boot/data/bootstrap.ts")).text()
    expect(runtimeRecord).toMatch(/sessionWorkspaceRuntimeRef/)
    expect(runtimeRecord).not.toMatch(/workspaceIdFromDirectoryRef/)
    expect(runtimeStore).toMatch(/runtimeScope/)
    expect(runtimeStore).toMatch(/workspaceRuntimeEnsureQueryKey/)
    expect(runtimeStore).toMatch(/"workspace-runtime-ensure"/)
    expect(runtimeStore).not.toMatch(/ensureRuntimeInflight/)
    expect(runtimeStore).not.toMatch(/ensureRuntimeFresh/)
    expect(runtimeStore).not.toMatch(/workspaceIdFromDirectoryRef/)
    expect(agentRuntimeClient).toMatch(/agentRuntimeWorkspaceTargetQueryKey/)
    expect(agentRuntimeClient).toMatch(/"agent-runtime-workspace-target"/)
    expect(agentRuntimeClient).not.toMatch(/workspaceTargets = new Map/)
    expect(httpBackend).toMatch(/sessionWorkspaceRuntimeRef/)
    expect(httpBackend).not.toMatch(/workspaceIdFromDirectoryRef/)
    expect(globalSync).toMatch(/sessionWorkspaceRuntimeRef/)
    expect(globalSync).not.toMatch(/workspaceIdFromDirectoryRef/)
    expect(globalSyncBootstrap).toMatch(/sessionWorkspaceRuntimeRef/)
    expect(globalSyncBootstrap).not.toMatch(/workspaceIdFromDirectoryRef/)
    expect(offenders).toEqual([])
  })

  test("runtime target predicates stay collapsed into transport and resolver owners", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      const text = await Bun.file(path.join(root, file)).text()
      if (
        /\bshouldUse(?:WorkspaceRelay|SignedControlPlaneSession|WorkspaceRuntimeSession|LoopbackWorkspaceBridge)\b/.test(
          text,
        )
      ) {
        offenders.push(`${file}: reintroduced a legacy RuntimeGateway predicate`)
      }
      // No exemption: the mint body states `backing` and nothing else, so no
      // module has a producer word of its own left to narrow privately.
      if (/\bfunction\s+runtimeKind\s*\(/.test(text)) {
        offenders.push(`${file}: reintroduced a private runtimeKind decision`)
      }
    }
    const submitTransport = await Bun.file(path.join(root, "features/session/composer/ui/submit-transport.ts")).text()
    const transport = await Bun.file(path.join(root, "platform/runtime/transport.ts")).text()
    expect(submitTransport).not.toMatch(
      /shouldUse(?:WorkspaceRelay|SignedControlPlaneSession|WorkspaceRuntimeSession|LoopbackWorkspaceBridge)/,
    )
    expect(submitTransport).toMatch(/submitTransportForPlacement/)
    expect(transport).toMatch(/submitTransportForPlacement/)
    expect(offenders).toEqual([])
  })

  test("workspace selector string-shape parsing stays behind identity boundaries", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      const text = await Bun.file(path.join(root, file)).text()
      if (!workspaceSelectorSyntaxBoundary.has(file) && /\b(?:isWorkspaceIdRef|workspaceIdFromRef)\b/.test(text)) {
        offenders.push(`${file}: uses raw workspace selector syntax parser`)
      }
      if (!workspaceRuntimeIdentityBoundary.has(file) && /\bworkspaceIdFromDirectoryRef\b/.test(text)) {
        offenders.push(`${file}: derives workspace id from directory ref outside runtime identity boundary`)
      }
      if (/RuntimeGateway\.(?:isWorkspaceIdRef|workspaceIdFromDirectoryRef)\b/.test(text)) {
        offenders.push(`${file}: calls RuntimeGateway workspace selector compatibility helper`)
      }
    }

    const request = await Bun.file(path.join(root, "platform/runtime/agent/workspace-runtime-request.ts")).text()
    const legacyResolver = await Bun.file(path.join(root, "platform/identity/legacy-resolver.ts")).text()
    // workspaceIdFromRef is the one canonical selector name; no wrapper alias.
    expect(await Bun.file(path.join(root, "platform/sync/worktree.ts")).text()).toMatch(/workspaceIdFromRef/)
    expect(request).toMatch(/workspaceIdFromRef/)
    expect(legacyResolver).toMatch(/workspaceIdFromRef/)
    expect(offenders).toEqual([])
  })

  test("raw legacy string-shape predicate names stay inside the resolver owner", async () => {
    // Importing these predicates from legacy-resolver.ts is the sanctioned
    // pattern. This rule guards against a file re-declaring one locally or
    // acquiring the name from anywhere other than the resolver owner.
    const rawNames = [
      "isFilesystemDirectory",
      "workspaceIdFromDirectoryRef",
      "isWorkspaceIdRef",
      "workspaceIdFromRef",
    ]
    const rawNamePattern = new RegExp(`\\b(?:${rawNames.join("|")})\\b`, "g")
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (file === "platform/identity/legacy-resolver.ts") continue
      if (file.startsWith("architecture/")) continue
      const text: string = await Bun.file(path.join(root, file)).text()
      const usedNames = new Set(text.match(rawNamePattern) ?? [])
      if (usedNames.size === 0) continue

      const importedFromResolver = new Set<string>()
      for (const match of text.matchAll(
        /(?:import|export)\s*(?:type\s*)?\{([^}]+)\}\s*from\s*["'][^"']*legacy-resolver["']/g,
      )) {
        for (const spec of match[1].split(",")) {
          const name = spec.trim().replace(/\s+as\s+\w+$/, "")
          if (name) importedFromResolver.add(name)
        }
      }

      const offendingNames = Array.from(usedNames).filter((name) => {
        const redeclared = new RegExp(`\\b(?:function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\b)`).test(text)
        return redeclared || !importedFromResolver.has(name)
      })
      if (offendingNames.length > 0) offenders.push(`${file}: ${offendingNames.join(", ")}`)
    }
    expect(offenders).toEqual([])
  })

  test("test fixtures mock RuntimeGateway instead of workspace runtime internals outside helper tests", async () => {
    const offenders: string[] = []
    const allowed = new Set(["platform/runtime/agent/workspace-runtime-request.test.ts"])
    for (const entry of await Array.fromAsync(new Bun.Glob("**/*.{test,vitest}.{ts,tsx}").scan({ cwd: root }))) {
      if (allowed.has(entry)) continue
      const text = await Bun.file(path.join(root, entry)).text()
      if (/mock\.(?:module|mock)\(\s*["'][^"']*workspace-runtime-request["']/.test(text)) {
        offenders.push(entry)
      }
      if (/vi\.mock\(\s*["'][^"']*workspace-runtime-request["']/.test(text)) {
        offenders.push(entry)
      }
    }
    expect(offenders).toEqual([])
  })

  test("production code builds runner config routes only through route boundaries", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (runtimeGatewayBoundary.has(file)) continue
      const text = await Bun.file(path.join(root, file)).text()
      if (/\/api\/claxedo\/agent-config\/runner/.test(text)) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  test("production code builds provider credential routes only through route boundaries", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (runtimeGatewayBoundary.has(file)) continue
      const text = await Bun.file(path.join(root, file)).text()
      if (/\/api\/claxedo\/credentials/.test(text)) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  test("production code stores provider credentials only through Claxedo credential routes", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      const text = await Bun.file(path.join(root, file)).text()
      if (/\b(?:globalSDK\.)?client\.auth\.set\(/.test(text)) offenders.push(`${file}: calls upstream auth.set`)
      if (/auth:\s*\{[\s\S]{0,160}key:/.test(text)) offenders.push(`${file}: builds upstream API key auth payload`)
    }
    expect(offenders).toEqual([])
  })

  test("credential entry surfaces do not persist raw secrets client-side", async () => {
    const connect = await Bun.file(path.join(root, dialogConnectProvider)).text()
    const sandbox = await Bun.file(path.join(root, settingsSandboxSection)).text()

    for (const text of [connect, sandbox]) {
      expect(text).not.toMatch(/\b(?:localStorage|sessionStorage)\b/)
      expect(text).not.toMatch(/\b(?:Persist\.global|persisted|setPersisted)\b/)
    }
    expect(connect).toMatch(/claxedoCredentialRequest/)
    expect(sandbox).toMatch(/createSignal<Record<string, Record<string, string>>>/)
    expect(sandbox).toMatch(/workspaceSandboxDriverAuthUrl/)
    expect(sandbox).not.toMatch(/RuntimeGateway/)
  })

  test("workspace mutation UIs are gated by backend-derived role policy", async () => {
    const networkPolicy = await Bun.file(path.join(root, networkPolicySettings)).text()
    const serverNetworkPolicyTest = await Bun.file(
      path.join(root, "..", "..", "claxedo-local-server/src/sandbox/network/network-policy-routes.test.ts"),
    ).text()

    expect(networkPolicy).not.toMatch(/RuntimeGateway\.workspaceConnectionUrl/)
    expect(networkPolicy).toMatch(/openWorkspaceConnection/)
    expect(networkPolicy).toMatch(/placementFromWorkspaceConnection/)
    expect(networkPolicy).toMatch(/can\("mutate\.workspace", workspacePlacement\(\)\)/)
    expect(networkPolicy).toMatch(/disabled=\{!canWritePolicy\(\)/)
    // Behavior over source-text: exercise the REAL exported role→capability
    // matrix instead of pinning literal `new Set([...])` source (the
    // connection-scoping feature legitimately extended the editor set with
    // `use.terminal`). The invariant this guards: admin inherits the full owner
    // capability set; editors may act within a session but never mutate the
    // workspace or manage runners; viewers are read-only and cannot use the
    // terminal.
    const placement = (role: RelayRole): Placement => ({
      workspaceId: "ws",
      hosting: "workspace",
      transport: "loopback",
      role,
    })
    const byName = (a: string, b: string) => a.localeCompare(b)
    expect([...RolePolicy.admin].sort(byName)).toEqual([...RolePolicy.owner].sort(byName))
    expect(can("mutate.session", placement("editor"))).toBe(true)
    expect(can("mutate.workspace", placement("editor"))).toBe(false)
    expect(can("manage.runners", placement("editor"))).toBe(false)
    expect(can("read.workspace", placement("viewer"))).toBe(true)
    expect(can("use.terminal", placement("viewer"))).toBe(false)
    expect(serverNetworkPolicyTest).toMatch(/signed workspace writes require admin authority/)
  })

  test("production code builds Claxedo health routes only through route boundaries", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (runtimeGatewayBoundary.has(file)) continue
      const text = await Bun.file(path.join(root, file)).text()
      if (/\/api\/claxedo\/health/.test(text)) {
        offenders.push(file)
      }
    }
    const app = await Bun.file(path.join(root, "app/entry/app.tsx")).text()
    const health = await Bun.file(path.join(root, "app/connection/server-health.ts")).text()

    expect(app).toMatch(/@\/app\/connection\/server-health/)
    expect(app).not.toMatch(/@\/shared\/data\/server-health/)
    expect(app).not.toMatch(/@\/utils\/server-health/)
    expect(await Bun.file(path.join(root, "overrides/app/connection/server-health.ts")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "overrides/app/connection/server-health.test.ts")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "app/connection/server-health.ts")).exists()).toBe(true)
    expect(health).toMatch(/queryClient/)
    expect(health).not.toMatch(/createSdkForServer/)
    expect(offenders).toEqual([])
  })

  test("production code builds Documents API routes only through its route boundary", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (runtimeGatewayBoundary.has(file)) continue
      if (file === "features/documents/data/documents-api.ts") continue
      const text = codeOnly(await Bun.file(path.join(root, file)).text())
      if (/["'`]\/documents(?:[?"'`/])/.test(text)) {
        offenders.push(file)
      }
      if (/\$\{[^}]+\}\/documents(?:[?"'`/])/.test(text)) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  test("production code builds Claxedo session metadata routes only through route boundaries", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (runtimeGatewayBoundary.has(file)) continue
      const text = await Bun.file(path.join(root, file)).text()
      if (/\/api\/claxedo\/session\/[^"']*\/meta/.test(text)) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  test("production code builds workspace relay connection routes only through route boundaries", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (runtimeGatewayBoundary.has(file)) continue
      const text = await Bun.file(path.join(root, file)).text()
      if (/\/api\/workspace\/[^"']*\/connection/.test(text)) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  test("production code builds workspace control-plane routes only through route boundaries", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (runtimeGatewayBoundary.has(file)) continue
      const text = codeOnly(await Bun.file(path.join(root, file)).text())
      if (/["'`]\/api\/workspace(?:[?"'`/])/.test(text)) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  test("production code builds control-plane session and event routes only through route boundaries", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (runtimeGatewayBoundary.has(file)) continue
      const text = await Bun.file(path.join(root, file)).text()
      if (/["'`]\/api\/control\/(?:sessions|events)(?:[?"'`/])/.test(text)) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  test("client UI does not sequence signed/web hybrid session creation", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      const text = await Bun.file(path.join(root, file)).text()
      if (/createHybridSession\b/.test(text)) offenders.push(`${file}: calls central hybrid creation collaborator`)
      if (/controlSessionListUrl\([^)]*\)[\s\S]{0,240}method:\s*["']POST["']/.test(text)) {
        offenders.push(`${file}: posts to central control session creation`)
      }
      if (/mode:\s*["']hybrid["']/.test(text)) offenders.push(`${file}: builds hybrid session creation payload`)
    }
    expect(offenders).toEqual([])
  })

  test("production code builds OpenCode session list routes only through route boundaries", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (runtimeGatewayBoundary.has(file)) continue
      const text = await Bun.file(path.join(root, file)).text()
      if (/["'`]\/session\?/.test(text)) {
        offenders.push(file)
      }
      if (/getDefaultBaseUrl\(\)\}\/session\?/.test(text)) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  test("production code builds Claxedo event stream routes only through route boundaries", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (runtimeGatewayBoundary.has(file)) continue
      const text = codeOnly(await Bun.file(path.join(root, file)).text())
      if (/["'`]\/api\/claxedo\/events(?:[?"'`])/.test(text)) {
        offenders.push(file)
      }
    }
    // The stream targets are chosen in `claxedo-event-targets.ts`; the provider
    // beside it only opens what that module returns.
    const targets = await Bun.file(path.join(root, "app/integrations/claxedo-event-targets.ts")).text()
    expect(targets).toMatch(/sessionWorkspaceRuntimeRef/)
    expect(targets).not.toMatch(/workspaceIdFromDirectoryRef/)
    expect(offenders).toEqual([])
  })

  test("production code builds workspace file and search routes only through route boundaries", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (runtimeGatewayBoundary.has(file)) continue
      const text = await Bun.file(path.join(root, file)).text()
      if (/["'`](?:\/file(?:\/content|\/status)?|\/find\/file)["'`]/.test(text)) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  test("production code builds workspace runtime status routes only through route boundaries", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (runtimeGatewayBoundary.has(file)) continue
      const text = await Bun.file(path.join(root, file)).text()
      if (/["'`](?:\/vcs|\/mcp)["'`]/.test(text)) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  test("production code builds workspace agent and provider routes only through route boundaries", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (runtimeGatewayBoundary.has(file)) continue
      const text = codeOnly(await Bun.file(path.join(root, file)).text())
      const productionLines = text
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("//"))
        .join("\n")
      if (/["'`](?:\/agent|\/command|\/provider)(?:[?"'`])/.test(productionLines)) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  test("production code builds experimental session and sandbox routes only through route boundaries", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (runtimeGatewayBoundary.has(file)) continue
      const text = await Bun.file(path.join(root, file)).text()
      if (/["'`](?:\/experimental\/session|\/api\/experimental\/sandbox)(?:[?"'`])/.test(text)) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  test("production code mutates session status only through the dispatcher owner", async () => {
    const offenders: string[] = []
    const patterns = [
      /\b\w*set\w*\(\s*["']session_status(?:_meta)?["']/,
      /\b(?:draft|state)\.session_status(?:_meta)?\[[^\]]+\]\s*=/,
      /delete\s+(?:draft|state)\.session_status(?:_meta)?\[[^\]]+\]/,
    ]
    for (const file of await files(root)) {
      if (sessionStatusBoundary.has(file)) continue
      const text = await Bun.file(path.join(root, file)).text()
      if (patterns.some((pattern) => pattern.test(text))) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  test("production session status, request, todo, and diff writes stay behind shell data writers", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (file === "features/session/data/sync/queries.ts" || file === "features/session/data/sync/writers.ts") continue
      const text = await Bun.file(path.join(root, file)).text()
      for (const match of text.matchAll(
        /setQueryData\([\s\S]{0,160}shellDataKeys\.sessionId\([\s\S]{0,120}"(status|requests|todo|diff)"/g,
      )) {
        offenders.push(`${file}: writes shell session ${match[1]} query directly`)
      }
    }
    expect(offenders).toEqual([])
  })

  test("global sync does not run the retired session-status watchdog", async () => {
    const text = await Bun.file(path.join(root, globalSyncContext)).text()

    expect(text).not.toMatch(/setInterval\([\s\S]{0,500}session_status_meta/)
    expect(text).not.toMatch(/applySessionStatusWatchdogToState/)
    expect(text).not.toMatch(/SESSION_STATUS_WATCHDOG/)
  })

  test("production code renders SessionPage only through Workbench SessionContent", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (sessionRenderBoundary.has(file)) continue
      const text = await Bun.file(path.join(root, file)).text()
      if (/import\([^)]*(?:overrides\/pages\/session|@\/pages\/session["'])/.test(text)) {
        offenders.push(`${file}: lazy-loads SessionPage outside Workbench`)
      }
      if (/from\s+["'][^"']*(?:overrides\/pages\/session|@\/pages\/session)["']/.test(text)) {
        offenders.push(`${file}: imports SessionPage outside Workbench`)
      }
    }
    expect(offenders).toEqual([])
  })

  test("Home reads project inventory through query options", async () => {
    const text = await Bun.file(path.join(root, homePage)).text()

    expect(text).toMatch(/useQueryOptions/)
    expect(text).toMatch(/queryOptions\.projects\(\)/)
    expect(text).toMatch(/queryOptions\.path\(null\)/)
    expect(text).toMatch(/ensureLocalProject/)
    expect(text).not.toMatch(/useGlobalSync/)
    expect(text).not.toMatch(/project\.ensure/)
    expect(text).not.toMatch(/sync\.data\.project/)
    expect(text).not.toMatch(/sync\.data\.path/)
  })

  test("production consumers do not call global-sync project inventory actions", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      const text = await Bun.file(path.join(root, file)).text()
      if (/\b(?:globalSync|props\.globalSync|sync)\.project\.(?:ensure|reload)\(/.test(text)) offenders.push(file)
    }

    expect(offenders).toEqual([])
  })

  test("DialogEditProject writes project metadata through query helpers", async () => {
    const text = await Bun.file(path.join(root, dialogEditProject)).text()

    expect(text).toMatch(/setProjectIcon/)
    expect(text).toMatch(/upsertProjectMeta/)
    expect(text).not.toMatch(/useGlobalSync/)
    expect(text).not.toMatch(/globalSync\.project\.(?:meta|icon)/)
  })

  test("app shell reads project inventory through query options", async () => {
    const text = await Bun.file(path.join(root, appShellState)).text()

    expect(text).toMatch(/useQueryOptions/)
    expect(text).toMatch(/queryOptions\.projects\(\)/)
    expect(text).toMatch(/queryOptions\.path\(null\)/)
    expect(text).toMatch(/useDirectorySessionCacheActions/)
    expect(text).toMatch(/directorySessionCacheActions\.ensure\(\{ directory, workspace: routeWorkspaceBacking\(\) \}\)/)
    expect(text).toMatch(/routeSessionWorkspaceBacking\(\{[\s\S]{0,180}workspaceId/)
    expect(text).toMatch(/\?\? sessionWorkspaceRuntimeRef\(\{ directory: workspaceId \}\)/)
    expect(text).toMatch(/sessionInventoryQueryOptions/)
    expect(text).not.toMatch(/globalSync\.data\.project/)
    expect(text).not.toMatch(/globalSync\.sessionInventory\.store/)
    expect(text).not.toMatch(/globalSync\.data\.path\.home/)
    expect(text).not.toMatch(/globalSync\.child/)
  })

  test("production consumers do not read or write the global-sync compatibility store directly", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      const text = await Bun.file(path.join(root, file)).text()
      if (/(?:props\.)?globalSync\.data|(?:props\.)?globalSync\.set\(/.test(text)) offenders.push(file)
    }
    const context = await Bun.file(path.join(root, globalSyncContext)).text()
    const sdkClientCache = await Bun.file(path.join(root, "platform/sync/global-sync-sdk-client-cache.ts")).text()

    expect(offenders).toEqual([])
    expect(context).not.toMatch(/data:\s*globalStore/)
    expect(context).not.toMatch(/\n\s*set,\n/)
    expect(context).not.toMatch(/function sessionScopedKey/)
    expect(context).not.toMatch(/\$\{directory\}\\n\$\{sessionID\}/)
    expect(context).toMatch(/cachedGlobalSyncServerClient/)
    expect(context).toMatch(/clearGlobalSyncServerClientsForDirectory/)
    expect(context).toMatch(/@\/features\/session\/data\/sync\/global-sync-types/)
    expect(context).not.toMatch(/@\/shell\/data\/global-sync-types/)
    expect(context).not.toMatch(/@\/context\/global-sync\/types/)
    expect(context).not.toMatch(/sdkCache = new Map/)
    expect(context).not.toMatch(/sdkCache\.(?:get|set|delete|keys)/)
    expect(sdkClientCache).toMatch(/"global-sync-server-client"/)
    expect(sdkClientCache).toMatch(/queryClient\.setQueryData/)
    expect(await Bun.file(path.join(root, "overrides/context/global-sync/sdk-client-cache.ts")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "platform/sync/global-sync-sdk-client-cache.ts")).exists()).toBe(true)
    expect(context).not.toMatch(/child:\s*children\.child/)
    expect(context).not.toMatch(/peek:\s*children\.peek/)
    expect(context).not.toMatch(/updateConfig:/)
    expect(context).not.toMatch(/project:\s*projectApi/)
    expect(context).not.toMatch(/todo:\s*\{/)
    expect(context).not.toMatch(/createStore<GlobalStore>/)
    expect(context).toMatch(
      /import \{ createDirectoryCacheManager \} from "@\/platform\/sync\/directory-cache-manager"/,
    )
    expect(context).not.toMatch(/(?:function|const|let)\s+createDirectoryCacheManager/)
    expect(await Bun.file(path.join(root, "overrides/context/global-sync/child-store.ts")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "overrides/context/global-sync/bootstrap.ts")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "overrides/context/global-sync/directory-cache-manager.ts")).exists()).toBe(
      false,
    )
    expect(await Bun.file(path.join(root, "app/boot/data/bootstrap.ts")).exists()).toBe(true)
    expect(await Bun.file(path.join(root, "platform/sync/directory-cache-manager.ts")).exists()).toBe(true)
  })

  test("production useGlobalSync calls are confined to shell boundary adapters", async () => {
    const allowed = new Set([
      globalSyncContext,
      "features/session/data/sync/directory-session-cache.ts",
      "app/integrations/sync/global-bootstrap.ts",
      "app/integrations/sync/global-sync-boundary.ts",
      // Reviewed shell adapter: binds GlobalSync's channel to the dedicated
      // session-access revocation contract without exposing GlobalSync to UI.
      "app/integrations/sync/session-access-revocations.ts",
      "features/session/data/sync/session-inventory.ts",
    ])
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (allowed.has(file)) continue
      const text = await Bun.file(path.join(root, file)).text()
      if (/\buseGlobalSync\(/.test(text)) offenders.push(file)
    }

    expect(offenders).toEqual([])
  })

  test("session inventory actions are isolated behind the shell data boundary", async () => {
    const allowed = new Set([globalSyncContext, "features/session/data/sync/session-inventory.ts"])
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (allowed.has(file)) continue
      const text = await Bun.file(path.join(root, file)).text()
      if (
        /sessionInventory\.(?:load|reloadWorkspace|loadMoreWorkspace|loadMore|drop)|globalSync\.sessionInventory/.test(
          text,
        )
      ) {
        offenders.push(file)
      }
    }
    const inventory = await Bun.file(path.join(root, "features/session/data/sync/session-inventory.ts")).text()
    const context = await Bun.file(path.join(root, globalSyncContext)).text()
    const rail = await Bun.file(path.join(root, railSidebar)).text()
    const layout = await Bun.file(path.join(root, layoutContext)).text()
    const controller = await Bun.file(path.join(root, sessionController)).text()

    // The inventory snapshot has ONE reader left: it seeds which rail sections
    // open. Rendered rows, pagination and freshness belong to each section's
    // own source, so the reload and the two paginators are gone.
    expect(inventory).toMatch(/loadSessionInventory/)
    expect(inventory).toMatch(/useSessionInventoryActions/)
    expect(inventory).not.toMatch(/reloadSessionInventory/)
    expect(inventory).not.toMatch(/loadMoreSessionInventoryWorkspace/)
    expect(await Bun.file(path.join(root, "overrides/context/global-sync/global-session-identity.ts")).exists()).toBe(
      false,
    )
    // Behavior over source-text: session identity is keyed on `id`, with
    // directory/workspace only DISAMBIGUATING same-id rows — directory equality
    // is never the sole identity key.
    expect(sameSessionIdentity({ id: "s1" }, { id: "s1" })).toBe(true)
    expect(sameSessionIdentity({ id: "s1" }, { id: "s2" })).toBe(false)
    expect(sameSessionIdentity({ id: "s1", directory: "/a" }, { id: "s2", directory: "/a" })).toBe(false)
    expect(sameSessionIdentity({ id: "s1", workspaceId: "wa" }, { id: "s1", workspaceId: "wb" })).toBe(false)
    expect(context).not.toMatch(/store:\s*globalSessionStore/)
    expect(rail).not.toMatch(/useSessionInventoryActions/)
    expect(rail).not.toMatch(/sessionInventoryActions\.loadMoreWorkspace/)
    expect(rail).not.toMatch(/sessionInventoryActions\.reloadWorkspace/)
    expect(rail).not.toMatch(/useGlobalSync/)
    expect(rail).not.toMatch(/globalSync/)
    expect(layout).toMatch(/useSessionInventoryActions/)
    expect(layout).toMatch(/sessionInventoryActions\.load\(\)/)
    // The workspace's own event stream carries a settled turn's row change; the
    // controller must not reload the whole inventory through the control plane.
    expect(controller).not.toMatch(/useSessionInventoryActions/)
    expect(controller).not.toMatch(/sessionInventoryActions\.reloadWorkspace/)
    expect(offenders).toEqual([])
  })

  test("production consumers warm sessions through query refresh boundaries, not project loadSessions", async () => {
    const allowed = new Set(["app/providers/global-sync/provider.tsx"])
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (allowed.has(file)) continue
      const text = await Bun.file(path.join(root, file)).text()
      if (/globalSync\.project\.loadSessions\(/.test(text)) offenders.push(file)
    }

    expect(offenders).toEqual([])
  })

  test("router params stay inside route-owned bridge surfaces", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (routeParamBoundary.has(file)) continue
      const text = await Bun.file(path.join(root, file)).text()
      if (/from\s+["']@solidjs\/router["']/.test(text) && /\buseParams\(\)/.test(text)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  test("legacy base64 shell redirects are centralized in shell route identity", async () => {
    const route = await Bun.file(path.join(root, "platform/identity/route.ts")).text()
    const layout = await Bun.file(path.join(root, appShellRouteSync)).text()
    const state = await Bun.file(path.join(root, appShellState)).text()
    const directoryLayout = await Bun.file(path.join(root, "app/routes/directory-layout.tsx")).text()

    expect(await Bun.file(path.join(root, "overrides/app/routes/directory-layout.tsx")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "app/routes/directory-layout.tsx")).exists()).toBe(true)
    expect(directoryLayout).toMatch(/resolveLegacyRedirect\(pathname/)
    expect(directoryLayout).toMatch(/\.\/directory-layout-routes/)
    expect(directoryLayout).not.toMatch(/@claxedo\/runtime\/runtime-gateway/)
    expect(directoryLayout).toMatch(/@\/platform\/api\/api/)
    expect(directoryLayout).not.toMatch(/\/page\/:pageId[\s\S]*workspacePageRoute/)
    expect(directoryLayout).not.toMatch(/\/terminal\/:terminalId[\s\S]*workspaceTerminalRoute/)
    expect(state).toMatch(/shellRouteDirectory\(shellRoute\(\)\)/)
    expect(layout).not.toMatch(/\bbase64Decode\b/)
    expect(layout).not.toMatch(/function decodeDir/)
    expect(route).toMatch(/legacyDirectoryRouteKey/)
    expect(route).toMatch(/workspacePageRoute\(resolved\.workspaceId, parsed\.pageId\)/)
    expect(route).toMatch(/workspaceTerminalRoute\(resolved\.workspaceId, parsed\.terminalId\)/)
    expect(route).toMatch(/shellRouteDirectory/)
    expect(route).not.toMatch(/\bcurrentRouteId\b/)
    expect(route).not.toMatch(/canonicalDirectory/)
  })

  test("terminal legacy directory keys stay behind shell route identity", async () => {
    const terminal = await Bun.file(path.join(root, terminalContext)).text()
    const preview = await Bun.file(path.join(root, "features/terminal/lib/terminal-session-preview.ts")).text()
    const localContext = await Bun.file(path.join(root, localContextOwner)).text()

    expect(await Bun.file(path.join(root, "overrides/features/terminal/providers/provider.tsx")).exists()).toBe(false)
    expect(terminal).toMatch(/legacyDirectoryFromRouteKey/)
    expect(terminal).toMatch(/legacyTerminalPersistScopeKey/)
    expect(terminal).toMatch(/terminalScopeKey/)
    expect(terminal).toMatch(/sessionWorkspaceRuntimeRef/)
    expect(terminal).not.toMatch(/workspaceIdFromDirectoryRef/)
    expect(terminal).not.toMatch(/@claxedo\/utils\/encode/)
    expect(terminal).not.toMatch(/\bbase64(?:Encode|Decode)\b/)
    expect(preview).toMatch(/legacyDirectoryFromRouteKey/)
    expect(preview).not.toMatch(/@claxedo\/utils\/encode/)
    expect(preview).not.toMatch(/\bbase64(?:Encode|Decode)\b/)
    expect(localContext).not.toMatch(/\bbase64(?:Encode|Decode)\b/)
  })

  test("raw legacy directory base64 helpers are confined to shell route identity", async () => {
    const allowedBase64Owners = new Set([
      "platform/identity/route.ts",
      "lib/encode.ts",
      "features/session/ui/dialogs/fork.tsx",
      "lib/base64.ts",
      "features/session/providers/permission-auto-respond.ts",
    ])
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (allowedBase64Owners.has(file)) continue
      const text = await Bun.file(path.join(root, file)).text()
      if (/\bbase64(?:Encode|Decode)\b/.test(text)) offenders.push(file)
    }

    expect(offenders).toEqual([])
  })

  test("SessionContextTab reads pane session identity from SessionParamsProvider only", async () => {
    const text = await Bun.file(path.join(root, sessionContextTab)).text()

    expect(
      await Bun.file(path.join(root, "overrides/features/session/ui/components/session-context-tab.tsx")).exists(),
    ).toBe(false)
    expect(text).not.toMatch(/@solidjs\/router/)
    expect(text).not.toMatch(/\buseParams\b/)
    expect(text).not.toMatch(/\bbase64Decode\b/)
    expect(text).not.toMatch(/try\s*\{[\s\S]{0,160}useSessionParams\(\)/)
    expect(text).not.toMatch(/\buseSync\b/)
    expect(text).not.toMatch(/sync\.data\.(?:message|part)/)
    expect(text).not.toMatch(/sync\.session\.get/)
    expect(text).not.toMatch(/sync\.session\.sync/)
    expect(text).toMatch(/directorySessionCacheQueryOptions/)
    expect(text).toMatch(/createActiveConversationSnapshot/)
    expect(text).not.toMatch(/useSessionSyncOptional/)
    expect(text).not.toMatch(/syncSession/)
  })

  test("production code does not retain the unused route-mode session context usage widget", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (file === "utils/workspace-runtime-route-audit.test.ts") continue
      const text = await Bun.file(path.join(root, file)).text()
      if (/\bSessionContextUsage\b|session-context-usage/.test(text)) offenders.push(file)
    }

    expect(await Bun.file(path.join(root, "components/session-context-usage.tsx")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "overrides/components/session-context-usage.tsx")).exists()).toBe(false)
    expect(offenders).toEqual([])
  })

  test("SessionPage does not keep a route-shaped params compatibility proxy", async () => {
    const text = await Bun.file(path.join(root, sessionPage)).text()

    expect(text).not.toMatch(/Backward-compatible params proxy/)
    expect(text).not.toMatch(/const\s+params\s*=/)
    expect(text).not.toMatch(/params\.(?:id|dir)/)
  })

  test("SessionPage reads project inventory through query options", async () => {
    const text = await Bun.file(path.join(root, sessionPage)).text()
    const cacheProjection = await Bun.file(
      path.join(root, "features/session/ui/session-screen-cache-projection.ts"),
    ).text()

    // Project inventory is read through query options: the reactive
    // `useQuery(() => queryOptions.projects())` reader lives in
    // `createSessionScreenCacheProjection`, which wraps it in an active-pane
    // projection; SessionPage consumes that projection's `projects` accessor.
    // (The incidental imperative
    // `queryClient.fetchQuery(queryOptions.projects())` warm-up lives with the
    // WorkspaceConnection authority — WorkspaceGate.)
    expect(text).toMatch(/createSessionScreenCacheProjection\(\{ active: paneActive, directory: dir \}\)/)
    expect(cacheProjection).toMatch(/useShellQueryOptions/)
    expect(cacheProjection).toMatch(/queryOptions\.projects\(\)/)
    expect(cacheProjection).toMatch(/useQuery\(\(\) => queryOptions\.projects\(\)\)/)
    expect(cacheProjection).not.toMatch(/\buseSync\b/)
    expect(cacheProjection).not.toMatch(/globalSync\./)
    expect(text).toMatch(/retargetSessionRef/)
    expect(text).toMatch(/source: activeSessionRef\(\)/)
    expect(text).not.toMatch(/\buseSync\b/)
    expect(text).not.toMatch(/globalSync\.data\.project/)
    expect(text).not.toMatch(/globalSync\.project\.reload/)
    expect(text).not.toMatch(/sync\.project/)
    expect(text).not.toMatch(/sync\.session\.evict/)
    expect(text).not.toMatch(/sync\.data\.path/)
    expect(text).not.toMatch(/sync\.data\.status/)
  })

  test("directory-scoped Local and File providers do not depend on SyncProvider or child-store mirrors", async () => {
    const local = await Bun.file(path.join(root, localContextOwner)).text()
    const localHandoff = await Bun.file(path.join(root, "features/session/store/local-selection-handoff.ts")).text()
    const file = await Bun.file(path.join(root, "app/providers/file.tsx")).text()
    const viewCache = await Bun.file(path.join(root, "platform/files/view-cache.ts")).text()
    const treeStore = await Bun.file(path.join(root, "platform/files/tree-store.ts")).text()
    const fileRequestCache = await Bun.file(path.join(root, "platform/files/file-request-cache.ts")).text()

    expect(await Bun.file(path.join(root, "overrides/context/local.tsx")).exists()).toBe(false)
    expect(local).toMatch(/agentListQuery/)
    expect(local).not.toMatch(/\bconfigQuery\b/)
    expect(local).toMatch(/getSessionConfig/)
    expect(local).toMatch(/useQuery/)
    expect(local).toMatch(/localSelectionHandoffQueryKey/)
    expect(local).toMatch(/resolveExplicitSelection|materializeModel/)
    expect(localHandoff).toMatch(/shellDataKeys\.sessionId\(sessionID, localSelectionHandoffPart\)/)
    expect(local).not.toMatch(/const handoff = new Map/)
    expect(local).not.toMatch(/handoff\.(?:get|set|has|delete)/)
    expect(local).not.toMatch(/Object\.values\(provider\.models\)\[0\]/)
    expect(local).not.toMatch(/\$\{dir\}\\n\$\{id\}/)
    expect(local).not.toMatch(/useGlobalSync/)
    expect(local).not.toMatch(/globalSync\.child/)
    expect(local).not.toMatch(/\buseSync\b/)
    expect(local).not.toMatch(/@solidjs\/router/)
    expect(file).toMatch(/cachedFileReadRequest/)
    expect(file).toMatch(/acquireFileRequestCache/)
    expect(file).toMatch(/@\/platform\/files\/view-cache/)
    expect(file).not.toMatch(/\.\/file\/view-cache/)
    expect(await Bun.file(path.join(root, "overrides/app/providers/file.tsx")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "overrides/platform/files/view-cache.ts")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "platform/files/view-cache.ts")).exists()).toBe(true)
    expect(viewCache).toMatch(/Persist\.serverScoped/)
    expect(viewCache).toMatch(/createScopedCache/)
    expect(file).not.toMatch(/const inflight = new Map/)
    expect(file).not.toMatch(/inflight\.(?:get|set|delete|clear)/)
    expect(file).not.toMatch(/\buseSync\b/)
    expect(file).not.toMatch(/@solidjs\/router/)
    expect(file).toMatch(/layout\.tabs\(scope\)/)
    expect(treeStore).toMatch(/cachedFileTreeRequest/)
    expect(treeStore).not.toMatch(/const inflight = new Map/)
    expect(treeStore).not.toMatch(/inflight\.(?:get|set|delete|clear)/)
    expect(fileRequestCache).toMatch(/fileRequestRuntimeQueryKey/)
    expect(fileRequestCache).toMatch(/createRefCountedResourceCache/)
    expect(local).toMatch(/agentListQuery\(\{/)
    expect(local).toMatch(/sessionConfigRawOptions/)
    expect(local).not.toMatch(/sync\.data\.agent/)
    expect(local).not.toMatch(/sync\.data\.config/)
  })

  test("harness submit model stays on canonical ModelKey boundaries", async () => {
    const harness = await Bun.file(path.join(root, harnessConfigStore)).text()
    const submit = await Bun.file(path.join(root, promptSubmit)).text()
    const submitTypes = await Bun.file(path.join(root, "features/session/submit/types.ts")).text()
    const submitResolve = await Bun.file(path.join(root, "features/session/submit/resolve.ts")).text()
    const modelGate = await Bun.file(path.join(root, "features/session/composer/ui/submit-model-gate.ts")).text()
    const strategy = await Bun.file(path.join(root, promptModelStrategy)).text()

    expect(harness).toMatch(/harnessModelKeyForSubmit/)
    expect(harness).toMatch(/harnessModelKeyForSubmit:\s*harnessStore\.harnessModelKeyForSubmit/)
    expect(harness).toMatch(/harnessModelNameForSubmit:\s*harnessStore\.harnessModelNameForSubmit/)
    expect(harness).not.toMatch(/harnessModelForSubmit/)

    expect(submit).toMatch(
      /modelKey:\s*\(\) => harnessController\.modelKeyForSubmit\(scope\)/,
    )
    expect(modelGate).toMatch(/resolveSubmittedConfig/)
    expect(modelGate).toMatch(/harnessModelKey:\s*input\.modelKey\(\)/)
    expect(submit).not.toMatch(/harnessModel:\s*/)
    expect(submit).not.toMatch(/submitModelFromModelKey/)

    expect(submitTypes).toMatch(/import type \{ ModelKey \} from "\.\.\/composer\/model-strategy"/)
    expect(submitTypes).toMatch(/harnessModelKey\?: ModelKey/)
    expect(submitTypes).not.toMatch(/harnessModel\?: SubmitModel/)

    expect(submitResolve).toMatch(/input\.harnessModelKey/)
    expect(submitResolve).not.toMatch(/input\.harnessModel\b/)
    expect(strategy).not.toMatch(/submitModelFromModelKey/)
  })

  test("production code does not own global-sync child stores", async () => {
    const allowed = new Set<string>()
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (allowed.has(file)) continue
      const text = await Bun.file(path.join(root, file)).text()
      if (/globalSync\.(?:workspaceScope\.)?child\b/.test(text)) offenders.push(file)
    }

    expect(offenders).toEqual([])

    const workspaceScopeHost = await Bun.file(path.join(root, "features/workspaces/data/workspace-scope.tsx")).text()
    const context = await Bun.file(path.join(root, globalSyncContext)).text()
    expect(workspaceScopeHost).not.toMatch(/globalSync\.workspaceScope\.child/)
    expect(workspaceScopeHost).not.toMatch(/globalSync\.child\b/)
    expect(context).not.toMatch(/\n\s*child:\s*children\.child/)
    expect(context).not.toMatch(/workspaceScope:\s*\{[\s\S]{0,80}child:\s*children\.child/)
    expect(context).not.toMatch(/\bcreateStore\b/)
    expect(context).not.toMatch(/\bGlobalStore\b/)
    expect(context).not.toMatch(/\b(?:Persist\.global|persisted)\b/)
    // The workspace catalog has one owner; global-sync reads and refreshes it
    // through that owner instead of holding the query key itself.
    expect(context).toMatch(/from "@\/features\/workspaces\/data\/workspace-catalog"/)
    expect(context).not.toMatch(/queryKeys\.controlPlane\.projects/)
    expect(context).toMatch(/setGlobalState/)
  })

  test("content renderers mount pane scope through SessionPaneScope", async () => {
    for (const file of contentRenderers) {
      const text = await Bun.file(path.join(root, file)).text()
      expect(text).toMatch(/SessionPaneScope/)
      expect(text).not.toMatch(/DirectoryScope/)
    }
  })

  test("content renderers read project inventory through query options", async () => {
    for (const file of projectInventoryContentRenderers) {
      const text = await Bun.file(path.join(root, file)).text()
      expect(text).toMatch(/useQueryOptions/)
      expect(text).toMatch(/queryOptions\.projects\(\)/)
      expect(text).not.toMatch(/useGlobalSync/)
      expect(text).not.toMatch(/globalSync\.data\.project/)
    }
  })

  test("Claxedo platform context owns desktop and auth platform capabilities", async () => {
    const platform = await Bun.file(path.join(root, platformContext)).text()

    expect(await Bun.file(path.join(root, "overrides/platform/runtime/platform-provider.tsx")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, platformContext)).exists()).toBe(true)
    expect(platform).toMatch(/getAuthToken\?: \(\) => Promise<string \| null>/)
    expect(platform).toMatch(/recordFatalRendererError\?/)
    expect(platform).toMatch(/runDesktopMenuAction\?/)
    // The platform context defines DesktopMenuAction itself rather than
    // importing it from a desktop-menu module.
    expect(platform).toMatch(/export type DesktopMenuAction =/)
    expect(platform).not.toMatch(/from "[^"]*desktop-menu"/)
    // No app/entry/desktop-menu.ts re-export exists; the platform context is the
    // sole owner of the type.
    expect(await Bun.file(path.join(root, "app/entry/desktop-menu.ts")).exists()).toBe(false)
    expect(platform).not.toMatch(/\.\.\/\.\.\/\.\.\/app\/src\/desktop-menu/)
    expect(platform).not.toMatch(/getWslEnabled/)
  })

  test("Claxedo language context owns extension string merging", async () => {
    const language = await Bun.file(path.join(root, languageContext)).text()
    const index = await Bun.file(path.join(root, "app/entry/index.tsx")).text()
    const app = await Bun.file(path.join(root, "app/entry/app.tsx")).text()
    const offenders: string[] = []
    for (const file of await files(root)) {
      const text = await Bun.file(path.join(root, file)).text()
      if (
        /@\/context\/language/.test(text) ||
        /["']\/context\/language["']/.test(text) ||
        /overrides\/context\/language/.test(text) ||
        /from\s+["']\.\/language["']/.test(text)
      ) {
        offenders.push(file)
      }
    }

    expect(await Bun.file(path.join(root, "overrides/platform/i18n/provider.tsx")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, languageContext)).exists()).toBe(true)
    expect(language).toMatch(/props\.strings\?\.\[current\]/)
    expect(app).toMatch(/<LanguageProvider strings=\{getExtensions\(\)\.app\.strings\}>/)
    expect(language).toMatch(/loadLocaleDict/)
    expect(language).toMatch(/normalizeLocale/)
    expect(language).not.toMatch(/createResource/)
    // The entry barrel does not re-export the i18n surface; the provider module
    // above is the single owner.
    expect(index).not.toMatch(/@\/platform\/i18n\/provider/)
    expect(offenders).toEqual([])
  })

  test("override resolver stays deleted after first-party aliases replace overrides", async () => {
    const appViteConfig = await Bun.file(path.join(root, "../vite.cloud.config.ts")).text()
    const appVitestConfig = await Bun.file(path.join(root, "../vitest.config.ts")).text()
    const appTsconfig = await Bun.file(path.join(root, "../tsconfig.json")).text()
    const desktopRenderer = await Bun.file(path.resolve(root, "../../claxedo-desktop/vite.renderer.ts")).text()
    const desktopTsconfig = await Bun.file(path.resolve(root, "../../claxedo-desktop/tsconfig.json")).text()
    // A missing overrides directory makes Bun.Glob.scan reject; treat it as an
    // empty override set, which satisfies this invariant.
    const overrideFiles = await Array.fromAsync(
      new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: path.join(root, "overrides") }),
    ).catch(() => [] as string[])
    const contentSurfaces = await Bun.file(path.join(root, "app/integrations/first-party-content-surfaces.tsx")).text()

    // There is no upstream packages/app to compare overrides against; what
    // matters is that the overrides dir is gone and every config resolves @/ to
    // claxedo-app's own src (asserted below).
    expect(overrideFiles).toEqual([])
    expect(contentSurfaces).toMatch(/localContentSurfaces/)

    for (const config of [appViteConfig, appVitestConfig, desktopRenderer]) {
      expect(config).not.toMatch(/name:\s*"claxedo-override-resolver"/)
      expect(config).not.toMatch(/function overrideResolver/)
      expect(config).not.toMatch(/CLAXEDO_OVERRIDES/)
      expect(config).not.toMatch(/function overrides/)
      expect(config).not.toMatch(/\.\.\.overrides\(\)/)
      expect(config).toMatch(/find:\s*"@\/"/)
    }

    // Post-divorce (plan 006): every config resolves @/ to claxedo-app's own
    // src — the per-file first-party owner alias lists are gone, and nothing
    // points back at packages/app/src.
    expect(appViteConfig).not.toMatch(/firstPartyOwners/)
    expect(appViteConfig).not.toMatch(/\.\.\/app\/src/)
    expect(appViteConfig).toMatch(
      /find: "@\/", replacement: normalizePath\(fileURLToPath\(new URL\("\.\/src\/", import\.meta\.url\)\)\)/,
    )
    // bootChunkModulepreloadPlugin injects <link rel="modulepreload"> for the
    // boot chunks at build time; the invariant is that no override-resolver
    // plugin returns.
    expect(appViteConfig).toMatch(/plugins:\s*\[solidPlugin\(\), tailwindcss\(\), bootChunkModulepreloadPlugin\(\)\]/)
    expect(appVitestConfig).not.toMatch(/firstPartyOwners/)
    expect(appVitestConfig).not.toMatch(/\.\.\/app\/src/)
    expect(appVitestConfig).toMatch(
      /find: "@\/", replacement: normalizePath\(fileURLToPath\(new URL\("\.\/src\/", import\.meta\.url\)\)\)/,
    )
    expect(appVitestConfig).toMatch(
      // vitest 2.1.9 bundles vite@5's types while the workspace resolves vite@7,
      // so the solid plugin needs one assertion to cross the two copies. The
      // `as unknown as` hop it used to take was redundant — the single `as`
      // compiles — and the invariant is that it stays a single one.
      /plugins:\s*\[solid\(\) as NonNullable<UserConfig\["plugins"\]>\[number\]\]/,
    )
    expect(appTsconfig).not.toMatch(/\.\.\/app\/src/)
    expect(appTsconfig).toMatch(/"@\/\*": \["\.\/src\/\*"\]/)

    expect(desktopRenderer).not.toMatch(/name:\s*"claxedo-override-resolver"/)
    expect(desktopRenderer).not.toMatch(/firstPartyOwners/)
    expect(desktopRenderer).not.toMatch(/\.\.\/app\/src/)
    // The boundary-manifest plugin is a first-party build-report emitter, not
    // a resolver; the invariant is that no override-resolver plugin returns.
    expect(desktopRenderer).toMatch(
      /plugins:\s*\[solidPlugin\(\), tailwindcss\(\), desktopRendererBoundaryManifestPlugin\(desktopDir\)\]/,
    )
    expect(desktopRenderer).toMatch(/find:\s*"@\/"/)
    expect(desktopRenderer).toMatch(
      /const upstreamRoot = normalize\(fileURLToPath\(new URL\("\.\.\/claxedo-app\/src\/", import\.meta\.url\)\)\)/,
    )
    expect(desktopRenderer).toMatch(/replacement:\s*upstreamRoot/)
    expect(desktopTsconfig).not.toMatch(/\.\.\/app\/src/)
    expect(desktopTsconfig).toMatch(/"@\/\*": \["\.\.\/claxedo-app\/src\/\*"\]/)
  })

  test("SessionPaneScope is the only production pane gateway to DirectoryScope", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (file === directoryScope || file === sessionPaneScope) continue
      const text = await Bun.file(path.join(root, file)).text()
      if (/from ["']\.\.?\/(?:components\/)?directory-scope["']/.test(text)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  test("SessionRef host placement is explicit and immutable at owner boundaries", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      const text = await Bun.file(path.join(root, file)).text()
      if (!sessionRefHostOwnerBoundary.has(file) && /host:\s*["'](?:central|workspace)["']\s*[,}]/.test(text)) {
        offenders.push(`${file}: constructs SessionRef host outside identity/orchestration owner`)
      }
    }

    expect(offenders).toEqual([])
  })

  test("generic auth fetch does not own workspace session transport routing", async () => {
    const api = await Bun.file(path.join(root, "platform/api/api.ts")).text()
    const globalSdk = await Bun.file(path.join(root, "app/providers/global-sdk/provider.tsx")).text()

    expect(api).not.toMatch(/workspaceRuntimeSessionFetch/)
    expect(api).not.toMatch(/createTransport/)
    expect(api).not.toMatch(/signedWorkspaceFromProjects/)
    expect(api).not.toMatch(/queryClient/)
    expect(api).not.toMatch(/queryKeys/)
    expect(globalSdk).not.toMatch(/createGlobalSdkFetch/)
    expect(globalSdk).toMatch(/createTransport/)
    const liveSession = await Bun.file(path.join(root, "app/providers/global-sdk/live-session.ts")).text()
    expect(liveSession).toMatch(/signedWorkspaceFromProjects/)
  })

  test("workspace URL producers pass IDs directly and never rely on a navigation suppression gate", async () => {
    const route = await Bun.file(path.join(root, "platform/identity/route.ts")).text()
    const shellState = await Bun.file(path.join(root, "app/app-shell-state.ts")).text()
    expect(route).not.toMatch(/workspaceSafeNavigationTarget/)
    expect(route).toMatch(/Workspace routes require an opaque workspace ID/)
    expect(shellState).toMatch(/routeIdentity\(\)\?\.routeId \?\? opaqueWorkspaceRouteId\(routeWorkspaceKey\(\)\)/)

    const offenders: string[] = []
    const glob = new Bun.Glob("**/*.{ts,tsx}")
    for (const discovered of glob.scanSync({ cwd: root, onlyFiles: true })) {
      const file = canonicalRelativePath(discovered)
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx") || file.endsWith(".vitest.tsx")) continue
      const text = await Bun.file(path.join(root, file)).text()
      for (const match of text.matchAll(/\b(?:workspace(?:Route|SessionRoute|PageRoute|TerminalRoute)|canonicalWorkspaceRoute|surfaceRoute)\(\s*([^,)\n]+)/g)) {
        const argument = match[1]?.trim() ?? ""
        if (argument === '""') continue
        if (/workspace.*id|routeId/i.test(argument)) continue
        const line = text.slice(0, match.index).split("\n").length
        offenders.push(`${file}:${line}: ${argument}`)
      }
      if (file !== "platform/identity/route.ts" && [
        /["'`]\/w\/\$\{/,
        /["'`]\/w\/["'`]\s*\+/,
        /(?:pathname|href)\s*=\s*["'`]\/w\//,
        /new URL\(\s*["'`]\/w\//,
      ].some((pattern) => pattern.test(text))) {
        offenders.push(`${file}: constructs or mutates /w/ directly`)
      }
      if (/navigate\(\s*`\/\$\{[^}]+\}\/session/.test(text)) {
        offenders.push(`${file}: constructs a directory-scoped session route directly`)
      }
    }
    expect(offenders).toEqual([])

    const scriptsRoot = path.resolve(root, "../scripts")
    const scriptOffenders: string[] = []
    for (const file of new Bun.Glob("**/*.{ts,mjs}").scanSync({ cwd: scriptsRoot, onlyFiles: true })) {
      if (file.endsWith(".test.ts")) continue
      const text = await Bun.file(path.join(scriptsRoot, file)).text()
      // Scripts reach workspace URLs only through the app's typed routes; any
      // `/w/${…}` literal is an offender.
      if (/\/w\/%2f/i.test(text) || /\/w\/\$\{/.test(text)) scriptOffenders.push(file)
    }
    expect(scriptOffenders).toEqual([])

    const fork = await Bun.file(path.join(root, "features/session/ui/dialogs/fork.tsx")).text()
    expect(fork).toMatch(/navigate\(sessionRoute\(forked\.data\.id\)\)/)
    expect(fork).not.toMatch(/base64Encode/)
  })

  test("terminal surface routes use typed workspace terminal routes", async () => {
    const migrated = [
      "features/terminal/actions/terminal-actions.ts",
      "features/terminal/ui/content/terminal-content.tsx",
      "app/workbench/state/surface-route.ts",
    ]

    const app = await Bun.file(path.join(root, "app/entry/app.tsx")).text()
    expect(app).toMatch(/path="\/w\/:workspaceId\/terminal\/:terminalId"/)

    for (const file of migrated) {
      const text = await Bun.file(path.join(root, file)).text()
      expect(text).toMatch(/workspaceTerminalRoute/)
      expect(text).not.toMatch(/`\/\$\{base64Encode\([^)]*\)\}\/terminal\/\$\{[^}]+\}`/)
      expect(text).not.toMatch(/legacyTerminalRoute/)
    }
  })

  test("migrated draft-session action surfaces use typed workspace session routes", async () => {
    const migrated = [
      "features/session/actions/session-actions.tsx",
      "features/workspaces/actions/workspace-actions.ts",
      "features/workspaces/actions/project-actions.tsx",
      "features/session/ui/components/session-new-design-view.tsx",
      "app/workbench/state/route-intent.ts",
      sessionCommandsHook,
      "features/session/ui/message-timeline.tsx",
      "features/session/ui/session-screen.tsx",
    ]

    for (const file of migrated) {
      const text = await Bun.file(path.join(root, file)).text()
      expect(text).toMatch(/workspaceSessionRoute/)
      expect(text).not.toMatch(/legacySessionRoute/)
      expect(text).not.toMatch(/base64Encode\([^)]*\).*\/session/)
    }

    const sessionPage = await Bun.file(path.join(root, "features/session/ui/session-screen.tsx")).text()
    const timeline = await Bun.file(path.join(root, "features/session/ui/message-timeline.tsx")).text()
    const lazyScreen = await Bun.file(path.join(root, "features/session/ui/session-screen-lazy.ts")).text()
    expect(await Bun.file(path.join(root, "overrides/features/session/ui/message-timeline.tsx")).exists()).toBe(false)
    // session-screen mounts the first-party message-timeline through the
    // session-screen-lazy code-split module, whose dynamic import resolves to
    // the canonical features/session/ui home — never through the retired
    // @/pages override alias; the row model is vendored as a colocated
    // sibling (packages/app was deleted in 007 Tier E).
    expect(sessionPage).toMatch(/@\/features\/session\/ui\/session-screen-lazy/)
    expect(lazyScreen).toMatch(/import\("@\/features\/session\/ui\/message-timeline"\)/)
    expect(sessionPage).not.toMatch(/@\/pages\/session\/message-timeline/)
    expect(lazyScreen).not.toMatch(/@\/pages\/session\/message-timeline/)
    expect(timeline).toMatch(/from "\.\/message-timeline\.data"/)
    expect(timeline).not.toMatch(/@\/pages\/session\/message-timeline\.data/)
  })

  test("migrated session view consumers use shell session view keys", async () => {
    const migrated = [
      "features/session/session-layout.ts",
      sessionCommandsHook,
      "features/session/ui/session-screen.tsx",
      "features/session/ui/components/session-context-tab.tsx",
      "features/session/ui/dialogs/select-file.tsx",
      "features/session/providers/prompt.tsx",
      "features/session/submit/handoff.ts",
    ]

    for (const file of migrated) {
      const text = await Bun.file(path.join(root, file)).text()
      expect(text).toMatch(/sessionViewKey/)
      expect(text).not.toMatch(/sessionKey\s*=\s*createMemo\(\(\)\s*=>\s*`\$\{?(?:dirEncoded|base64Encode)/)
      expect(text).not.toMatch(/setLayoutTabs\(base64Encode/)
    }

    const sessionPage = await Bun.file(path.join(root, "features/session/ui/session-screen.tsx")).text()
    const promptInputSource = await Bun.file(path.join(root, promptInput)).text()
    const promptSubmitSource = await Bun.file(path.join(root, promptSubmit)).text()
    expect(sessionPage).toMatch(/sessionWorkspaceRuntimeRef/)
    expect(sessionPage).not.toMatch(/workspaceIdFromDirectoryRef/)
    expect(sessionPage).not.toMatch(/dirEncoded/)
    expect(sessionPage).not.toMatch(/@claxedo\/utils\/encode/)
    expect(promptInputSource).toMatch(/const sessionKey = \(\) => modeSnapshot\(\)\.sessionKey/)
    expect(promptInputSource).not.toMatch(/sessionKey\s*=\s*createMemo\(\(\)\s*=>\s*`\$\{?(?:dirEncoded|base64Encode)/)
    expect(promptSubmitSource).toMatch(/promptViewScope/)
    expect(promptSubmitSource).toMatch(/panePreferenceScope/)
    expect(promptSubmitSource).not.toMatch(/base64Encode/)
  })

  test("session layout does not expose route-shaped directory params", async () => {
    const text = await Bun.file(path.join(root, "features/session/session-layout.ts")).text()
    const commands = await Bun.file(path.join(root, sessionCommandsHook)).text()

    expect(await Bun.file(path.join(root, "overrides/features/session/ui/use-session-commands.tsx")).exists()).toBe(
      false,
    )
    expect(await Bun.file(path.join(root, "overrides/pages/features/session/session-layout.ts")).exists()).toBe(false)
    expect(text).toMatch(/sessionViewKey/)
    expect(text).toMatch(/return sessionViewKey\(\{ sessionId: id \}\)/)
    expect(text).toMatch(/return sessionViewKey\(\{[\s\S]*directory: directory\(\),[\s\S]*sessionId: id,[\s\S]*\}\)/)
    expect(commands).toMatch(/return sessionViewKey\(\{ sessionId: id \}\)/)
    expect(commands).toMatch(
      /return sessionViewKey\(\{[\s\S]*directory: args\.directory\(\),[\s\S]*sessionId: id,[\s\S]*\}\)/,
    )
    expect(text).toMatch(/get id\(\)/)
    expect(text).not.toMatch(/base64Encode/)
    expect(text).not.toMatch(/get dir\(\)/)
  })

  test("sidebar session prefetch is cache-only, not a message store writer", async () => {
    const text = await Bun.file(path.join(root, railSidebar)).text()
    const prefetch = await Bun.file(path.join(root, "platform/sync/session-prefetch.ts")).text()
    // The rail's prefetch orchestration (supersede/quiet-window/abort policy)
    // split into rail-session-message-prefetch.ts; the sidebar composes the
    // factory instance and the query-cache writes stay in platform/sync.
    const railPrefetch = await Bun.file(path.join(root, "app/workbench/rail/rail-session-message-prefetch.ts")).text()

    expect(text).toMatch(/createRailSessionMessagePrefetch/)
    expect(text).toMatch(/prefetchSidebarSessionMessages/)
    expect(railPrefetch).toMatch(/setSessionPrefetch/)
    expect(railPrefetch).toMatch(/runSessionPrefetch/)
    for (const source of [text, railPrefetch]) {
      expect(source).not.toMatch(/prefetchQueues = new Map/)
      expect(source).not.toMatch(/prefetchedByDir = new Map/)
      expect(source).not.toMatch(/prefetchFail = new Map/)
    }
    expect(prefetch).toMatch(/function prefetchMetaKey\(directory: SessionPrefetchDirectory, sessionID: string\)/)
    expect(prefetch).toMatch(/shellDataKeys\.sessionId\(sessionID, "message-prefetch"\)/)
    expect(prefetch).toMatch(
      /function prefetchRequestKey\(directory: SessionPrefetchDirectory, sessionID: string, revision: number, generation: number\)/,
    )
    expect(await Bun.file(path.join(root, "overrides/context/global-sync/session-prefetch.ts")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "platform/sync/session-prefetch.ts")).exists()).toBe(true)
    expect(prefetch).toMatch(/directory: input\.directory/)
    expect(text).toMatch(/useQuery\(/)
    for (const source of [text, railPrefetch]) {
      expect(source).not.toMatch(/globalSync\.data\.project/)
      expect(source).not.toMatch(/globalSync\.project\.(?:meta|icon)/)
      expect(source).not.toMatch(/globalSync\.data\.path\.home/)
      expect(source).not.toMatch(/globalSync\.child/)
      expect(source).not.toMatch(/setStore\("message"/)
      expect(source).not.toMatch(/setStore\("part"/)
      expect(source).not.toMatch(/store\.message\[session\.id\]/)
      expect(source).not.toMatch(/sortedRootSessions\((?:dirStore|projectStore)/)
      expect(source).not.toMatch(/store\.session\s*\?\?/)
      expect(source).not.toMatch(/\$\{directory\}\\n\$\{sessionID\}/)
      expect(source).not.toMatch(/\$\{directory\}:\$\{props\.sessionID\}/)
      expect(source).not.toMatch(/\$\{currentDir\(\)\}:\$\{currentSession\}/)
      expect(source).not.toMatch(/scrollToSession\(session\.id, `\$\{session\.directory\}:\$\{session\.id\}`\)/)
    }
    expect(prefetch).not.toMatch(/\$\{directory\}\\n\$\{sessionID\}/)
  })

  test("production code does not retain the global-sync streaming delta store", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      const text = await Bun.file(path.join(root, file)).text()
      if (/part_text_accum_delta/.test(text)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  test("legacy conversation mirror writers are gone from production code", async () => {
    const offenders: string[] = []
    const patterns = [
      /applyConversationMirror/,
      /\b\w*set\w*\(\s*["'](?:message|part)["']/,
      /\b(?:draft|store)\.(?:message|part)\[[^\]]+\]\s*=/,
      /delete\s+(?:draft|store)\.(?:message|part)\[[^\]]+\]/,
    ]
    for (const file of await files(root)) {
      if (legacyConversationCleanupBoundary.has(file)) continue
      const text = await Bun.file(path.join(root, file)).text()
      if (patterns.some((pattern) => pattern.test(text))) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })

  test("Query-to-Solid compatibility bridge is deleted", async () => {
    const listEvents = await Bun.file(path.join(root, sessionListEvents)).text()
    const directoryCacheManager = await Bun.file(path.join(root, "platform/sync/directory-cache-manager.ts")).text()
    const offenders: string[] = []
    for (const file of await files(root)) {
      const text = await Bun.file(path.join(root, file)).text()
      if (/bridgeQueryToStore|queryToSolidBridge|shared\/query\/bridge/.test(text)) offenders.push(file)
    }

    expect(await Bun.file(path.join(root, "shared/query/bridge.ts")).exists()).toBe(false)
    expect(offenders).toEqual([])
    expect(directoryCacheManager).toMatch(/queryKeys\.directory\.sessionCache/)
    expect(directoryCacheManager).not.toMatch(/onCleanup\(bridgeQueryToStore/)
    expect(listEvents).toMatch(/case "vcs\.branch\.updated"/)
    expect(listEvents).not.toMatch(/setStore\("vcs"/)
    expect(listEvents).not.toMatch(/loadLsp/)
    expect(listEvents).not.toMatch(/setSessionRequestsFromStore/)
    expect(listEvents).not.toMatch(/store\.(?:permission|question)/)
    expect(listEvents).toMatch(/case "permission\.asked"/)
    expect(listEvents).toMatch(/case "permission\.replied"/)
    expect(listEvents).toMatch(/case "question\.asked"/)
    expect(listEvents).not.toMatch(/setStore\("(?:permission|question)"/)
  })

  test("SessionPage mounts the TanStack chat owner for live conversation events", async () => {
    const text = await Bun.file(path.join(root, sessionPage)).text()
    const contextContent = await Bun.file(path.join(root, "app/workbench/content/context-content.tsx")).text()
    const cacheProjection = await Bun.file(
      path.join(root, "features/session/ui/session-screen-cache-projection.ts"),
    ).text()

    expect(text).toMatch(/SessionConversationOwner/)
    expect(text).not.toMatch(/LegacySessionConversationOwner/)
    expect(text).toMatch(/sessionId=\{id\}/)
    // The SessionConversationOwner self-sources messages/parts from the shell
    // conversation queries (it is the TanStack chat owner); both the session
    // page and context-content mount it with `() => undefined` sentinels rather
    // than threading a Solid mirror in. The `messages` memo still feeds the
    // timeline and sessionUserMessages() (asserted below).
    expect(text).toMatch(
      /<SessionConversationOwner[\s\S]*messages=\{\(\) => undefined\}[\s\S]*parts=\{\(\) => undefined\}/,
    )
    expect(text).not.toMatch(/source=\{\(\) => sync\.data\}/)
    expect(text).not.toMatch(/sync\.data\.part\[messageID\]/)
    // Session rows come from the pane-scoped cache projection module, backed by
    // the directory session cache query and never a Solid mirror.
    expect(text).toMatch(/createSessionScreenCacheProjection/)
    expect(cacheProjection).toMatch(/directorySessionCacheQueryOptions/)
    expect(cacheProjection).not.toMatch(/createStore/)
    expect(cacheProjection).not.toMatch(/\buseSync\b/)
    expect(cacheProjection).not.toMatch(/sync\.data\.session/)
    expect(text).toMatch(/useSessionTitleProjection/)
    expect(text).not.toMatch(/sessionInventoryQueryOptions/)
    expect(text).not.toMatch(/indexSessionTitleInventory/)
    expect(text).not.toMatch(/sync\.session\.get/)
    expect(text).not.toMatch(/sync\.set\(/)
    expect(text).not.toMatch(/sync\.data\.session/)
    expect(text).not.toMatch(/sync\.data\.session_status/)
    expect(text).not.toMatch(/sync\.data\.(?:permission|question|session_diff)/)
    expect(text).toMatch(/activeTurn=\{sessionController\.activeTurn\}/)
    expect(text).toMatch(/diffFiles=\{diffFiles\}/)
    expect(text).not.toMatch(/extractPromptFromParts\(sync\.data\.part/)
    // The screen's conversation read goes through the pane-scoped registry
    // wrapper (createActiveConversationSnapshot wraps registeredConversationSnapshot).
    expect(text).toMatch(/createActiveConversationSnapshot/)
    expect(text).toMatch(/sessionUserMessages\(messages\(\)\)/)
    expect(text).not.toMatch(/conversation\(\)\.messages\.filter\(\(message\) => message\.role === "user"\)/)
    expect(contextContent).toMatch(/SessionConversationOwner/)
    expect(contextContent).not.toMatch(/LegacySessionConversationOwner/)
    expect(contextContent).not.toMatch(/source=\{\(\) => sync\.data\}/)
    expect(contextContent).not.toMatch(/sync\.data\.(?:message|part)\[/)
    expect(contextContent).toMatch(/messages=\{\(\) => undefined\}/)
    expect(contextContent).toMatch(/parts=\{\(\) => undefined\}/)
  })

  test("Workbench route and action surfaces read session rows from directory session cache", async () => {
    const layout = await Bun.file(path.join(root, appShellState)).text()
    const actions = await Bun.file(path.join(root, claxedoSessionActions)).text()
    const notification = await Bun.file(path.join(root, notificationContext)).text()

    expect(layout).toMatch(/useDirectorySessionCacheActions/)
    expect(layout).toMatch(/directorySessionCacheActions\.ensure/)
    expect(actions).toMatch(/directorySessionCacheQueryOptions/)
    expect(actions).toMatch(/removeSessionInventoryQueryData/)
    expect(notification).toMatch(/lookupNotificationSession/)
    expect(notification).toMatch(/directorySessions\(input\.directory\)/)
    expect(layout).not.toMatch(/store\.session\.(?:find|filter)/)
    expect(actions).not.toMatch(/store\.session\?\.(?:find|filter)/)
    expect(actions).not.toMatch(/globalSync\.sessionInventory\.drop/)
    expect(notification).not.toMatch(/globalSync\.child/)
    expect(notification).not.toMatch(/syncStore\.session/)
  })

  test("production code refreshes directories through the shell data boundary", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      const text = await Bun.file(path.join(root, file)).text()
      if (/globalSync\.refreshDirectory\(/.test(text)) offenders.push(file)
    }

    expect(offenders).toEqual([])
  })

  test("MessageTimeline renders from the registered chat projection", async () => {
    const text = await Bun.file(path.join(root, sessionTimeline)).text()
    const timelineProps = await Bun.file(path.join(root, "features/session/ui/message-timeline-props.ts")).text()

    // The conversation read goes through the pane-scoped registry wrapper
    // (createActiveConversationSnapshot wraps registeredConversationSnapshot).
    expect(text).toMatch(/const sessionConversation = createActiveConversationSnapshot\(\{/)
    expect(text).toMatch(
      /const sessionMessages = createMemo\(\(\) => sessionConversation\(\)\?\.messages \?\? emptyMessages\)/,
    )
    expect(text).toMatch(
      /const getMsgParts = \(msgId: string\) => sessionConversation\(\)\?\.parts\[msgId\] \?\? emptyParts/,
    )
    expect(text).toMatch(/const parentConversation = createActiveConversationSnapshot\(\{/)
    // Agents come from the session-kit data store projection, and session
    // rows arrive through the props boundary (the screen owns the directory
    // cache read via session-screen-cache-projection.ts, asserted in the
    // SessionPage test) — the timeline holds no query wiring of its own.
    expect(text).toMatch(/read: \(\) => data\.store\.agent \?\? \[\]/)
    expect(text).toMatch(/read: props\.directorySessions/)
    expect(timelineProps).toMatch(/directorySessions: Accessor<ClaxedoSession\[\]>/)
    // No configQuery: the timeline's only config read gated the session-share
    // menu, which Claxedo does not ship. `sync.data.config` stays banned below.
    expect(text).toMatch(/sessionSync\?\.syncSession\?\.\(id\)/)
    expect(text).not.toMatch(/\buseSync\b/)
    expect(text).not.toMatch(/sync\.session\.get/)
    expect(text).not.toMatch(/sync\.session\.sync/)
    expect(text).not.toMatch(/sync\.set\(/)
    expect(text).not.toMatch(/sync\.data\.(?:message|part)/)
    expect(text).not.toMatch(/sync\.data\.session/)
    expect(text).not.toMatch(/sync\.data\.session_status/)
    expect(text).not.toMatch(/sync\.data\.(?:agent|config)/)
    // The status accessor prop lives in the extracted props type.
    expect(timelineProps).toMatch(/status:\s*\(\) => SessionStatus/)
    expect(text).not.toMatch(/\bSessionContextUsage\b|session-context-usage/)
  })

  test("SessionController exposes visible messages from the registered chat projection", async () => {
    const text = await Bun.file(path.join(root, sessionController)).text()
    const paneQueries = await Bun.file(path.join(root, "features/session/store/session-pane-queries.ts")).text()
    const directoryMeta = await Bun.file(path.join(root, "features/session/store/directory-session-meta.ts")).text()

    // The conversation read goes through the pane-scoped registry wrapper
    // (createActiveConversationSnapshot wraps registeredConversationSnapshot).
    expect(text).toMatch(/createActiveConversationSnapshot\(\{ directory: input\.directory, sessionID: input\.sessionID/)
    expect(text).toMatch(/hydrateConversationPage/)
    // Shell query reads are consolidated in createSessionPaneQueries, which
    // observes the shellDataKeys session entries (status/requests/todo/diff +
    // directory cache) and holds no Solid store mirror.
    expect(text).toMatch(/createSessionPaneQueries\(\{/)
    expect(paneQueries).toMatch(/shellDataKeys\.sessionId\(sessionID, "status"\)/)
    expect(paneQueries).toMatch(/shellDataKeys\.sessionId\(sessionID, "requests"\)/)
    expect(paneQueries).toMatch(/shellDataKeys\.sessionId\(sessionID, "todo"\)/)
    expect(paneQueries).toMatch(/shellDataKeys\.sessionId\(sessionID, "diff"\)/)
    expect(paneQueries).toMatch(/directorySessionCacheQueryOptions/)
    expect(paneQueries).not.toMatch(/createStore/)
    expect(paneQueries).not.toMatch(/SetStoreFunction/)
    expect(text).toMatch(/dispatchSessionStatusEvent/)
    // Requests dispatch goes through the shared meta derivation
    // (applyDirectorySessionMeta in directory-session-meta.ts).
    expect(text).toMatch(/applyDirectorySessionMeta/)
    expect(directoryMeta).toMatch(/dispatchSessionRequestsEvent/)
    expect(directoryMeta).toMatch(/dispatchSessionStatusEvent/)
    expect(directoryMeta).not.toMatch(/createStore/)
    expect(directoryMeta).not.toMatch(/setStore/)
    expect(text).toMatch(/directorySessionCacheQueryOptions/)
    expect(text).toMatch(/const snapshot = activeConversation\(\)/)
    expect(text).toMatch(/dispatchSessionTodoEvent/)
    expect(text).toMatch(/useDirectorySessionCacheActions/)
    expect(text).toMatch(/directorySessionCacheActions\.refresh/)
    expect(text).not.toMatch(/\buseSync\b/)
    expect(text).not.toMatch(/sync\.session/)
    expect(text).not.toMatch(/sync\.session\.get/)
    expect(text).not.toMatch(/globalSync\.project\.loadSessions/)
    expect(text).not.toMatch(/sync\.data\.message/)
    expect(text).not.toMatch(/sync\.data\.session_status/)
    expect(text).not.toMatch(/SetStoreFunction/)
    expect(text).not.toMatch(/applySessionStatusEventToState/)
    expect(text).not.toMatch(/draft\.session_status/)
    expect(text).not.toMatch(/storeSession\(/)
    expect(text).not.toMatch(/sync\.data\.(?:todo|session_diff|permission|question)/)
    expect(text).not.toMatch(/storeTodo/)
    expect(text).not.toMatch(/setStore\("todo"/)
    expect(text).not.toMatch(/setStore\("(?:permission|question)"/)
    expect(text).not.toMatch(/draft\.(?:permission|question)/)
    expect(text).not.toMatch(/draft\.todo/)
    expect(text).not.toMatch(/applyConversationMirror/)
    expect(text).not.toMatch(/draft\.(?:message|part)/)
  })

  test("SessionController does not keep controller metadata in a Solid createStore mirror", async () => {
    const text = await Bun.file(path.join(root, sessionController)).text()
    const historyPagination = await Bun.file(path.join(root, "features/session/store/history-pagination.ts")).text()
    const paneQueries = await Bun.file(path.join(root, "features/session/store/session-pane-queries.ts")).text()
    const capabilitiesQuery = await Bun.file(
      path.join(root, "features/session/store/session-capabilities-query.ts"),
    ).text()

    // The controller wires createHistoryMetaState(), which backs history meta
    // with createSignal<HistoryMeta>, never a createStore mirror.
    expect(text).toMatch(/createHistoryMetaState\(\)/)
    expect(historyPagination).toMatch(/createSignal\(emptyHistoryMeta\(\)\)/)
    expect(historyPagination).not.toMatch(/createStore/)
    // sessionCapabilitiesKey (session-pane-queries.ts) derives from
    // shellDataKeys, and the capability fetch flows through
    // syncSessionCapabilitiesData (session-capabilities-query.ts) into the same
    // query-cache entry — no Solid mirror in either.
    expect(paneQueries).toMatch(/export function sessionCapabilitiesKey\(scope: SessionCapabilitiesScope\)/)
    expect(paneQueries).toMatch(/shellDataKeys\.sessionId\(\s*scope\.sessionID,\s*"transport-capabilities"/)
    expect(paneQueries).not.toMatch(/createStore/)
    expect(text).toMatch(/const key = sessionCapabilitiesKey\(\{/)
    expect(text).toMatch(/syncSessionCapabilitiesData/)
    expect(capabilitiesQuery).toMatch(/fetchSessionCapabilitiesByTransport/)
    expect(capabilitiesQuery).toMatch(/queryKey: sessionCapabilitiesKey\(\{/)
    expect(capabilitiesQuery).not.toMatch(/createStore/)
    expect(text).toMatch(/useDirectorySessionCacheActions/)
    expect(text).not.toMatch(/useGlobalSync/)
    expect(text).not.toMatch(/createStore\(/)
    expect(text).not.toMatch(/const \[compat, setCompat\]/)
    expect(text).not.toMatch(/const \[historyMeta, setHistoryMeta\] = createStore/)
  })

  test("SessionComposerState reads todo, request, and status state from shell session queries", async () => {
    const text = await Bun.file(path.join(root, sessionComposerState)).text()
    const region = await Bun.file(path.join(root, sessionComposerRegion)).text()
    const sessionPageText = await Bun.file(path.join(root, sessionPage)).text()

    expect(await Bun.file(path.join(root, "overrides/features/session/ui/composer/index.ts")).exists()).toBe(false)
    expect(
      await Bun.file(path.join(root, "overrides/features/session/ui/composer/session-composer-state.ts")).exists(),
    ).toBe(false)
    // There is no composer barrel: both consumers import the region and state
    // modules directly.
    expect(await Bun.file(path.join(root, sessionComposer)).exists()).toBe(false)
    expect(await Bun.file(path.join(root, sessionComposerRegion)).exists()).toBe(true)
    expect(await Bun.file(path.join(root, sessionComposerState)).exists()).toBe(true)
    // Region imports the SessionComposerState type from its colocated state
    // module by relative path, never re-declaring it or using the @/ alias.
    expect(region).toMatch(/from "\.\/session-composer-state"/)
    expect(region).not.toMatch(/@\/pages\/session\/composer\/session-composer-state/)
    // session-screen imports the first-party composer from its canonical
    // features/session/ui home, never through an @/pages alias.
    expect(sessionPageText).toMatch(/@\/features\/session\/ui\/composer/)
    expect(sessionPageText).not.toMatch(/@\/pages\/session\/composer/)
    expect(text).toMatch(/useSessionParams/)
    expect(text).toMatch(/@\/features\/session\/providers\/session-params/)
    expect(text).not.toMatch(/@\/claxedo-ui\/context\/session-params/)
    expect(text).toMatch(/@\/features\/session\/data\/sync\/queries/)
    expect(text).not.toMatch(/@\/shell\/data\/queries/)
    expect(text).toMatch(/directorySessionCacheQueryOptions/)
    // The per-session shell reads were renamed to their cache-observer
    // variants (same shellDataKeys entries, skipToken query fns) in queries.ts.
    expect(text).toMatch(/sessionStatusCacheQueryOptions/)
    expect(text).toMatch(/sessionTodoCacheQueryOptions/)
    expect(text).toMatch(/sessionRequestsCacheQueryOptions/)
    // The dock is presentation: an idle session hides it, and nothing here may
    // dispatch an empty todo list, which would erase canonical task data that
    // survives a reload.
    expect(text).not.toMatch(/dispatchSessionTodoEvent/)
    expect(text).toMatch(/useQueries/)
    expect(text).not.toMatch(/setQueryData\(shellDataKeys\.sessionId\(id, "todo"\)/)
    expect(text).not.toMatch(/@solidjs\/router/)
    expect(text).not.toMatch(/\buseSync\b/)
    expect(text).not.toMatch(/globalSync\.data\.session_todo/)
    expect(text).not.toMatch(/globalSync\.todo/)
    expect(text).not.toMatch(/sync\.data\.session/)
    expect(text).not.toMatch(/session_working/)
    expect(text).not.toMatch(/sync\.data\.(?:permission|question)/)
    expect(text).not.toMatch(/sync\.set\("todo"/)
  })

  test("upstream SessionComposerRegion reads session parent rows from directory cache", async () => {
    const text = await Bun.file(path.join(root, upstreamSessionComposerRegion)).text()
    const handoff = await Bun.file(path.join(root, "features/session/ui/prompt-preview-handoff.ts")).text()

    expect(text).toMatch(
      /directorySessions\(sessionDirectory\(\)\)\.find\(\(session\) => session\.id === sessionID\(\)\)/,
    )
    expect(text).toMatch(/const sessionID = createMemo\(\(\) => props\.sessionID \?\? route\.params\.id\)/)
    expect(text).toMatch(
      /const sessionDirectory = createMemo\(\(\) => props\.sessionDirectory \?\? route\.directory\(\)\)/,
    )
    expect(handoff).toMatch(/sessionHandoffQueryRoot/)
    expect(handoff).toMatch(/"session-handoff"/)
    expect(handoff).not.toMatch(/session: new Map/)
    expect(handoff).not.toMatch(/terminal: new Map/)
    expect(text).not.toMatch(/\buseSync\b/)
    expect(text).not.toMatch(/sync\.session\.get/)
  })

  test("upstream SessionContextUsage reads metrics from registered chat projection", async () => {
    const text = await Bun.file(path.join(root, sessionContextTab)).text()

    expect(await Bun.file(path.join(root, "components/session-context-usage.tsx")).exists()).toBe(false)
    expect(text).toMatch(/createActiveConversationSnapshot/)
    expect(text).toMatch(/local\.model\.current\(\)\?\.provider/)
    expect(text).not.toMatch(/useProviders\(/)
    expect(text).toMatch(/getSessionContextMetrics\(messages\(\), activeProviders\(\)\)/)
    expect(text).not.toMatch(/\buseSync\b/)
    expect(text).not.toMatch(/sync\.data\.message/)
  })

  test("upstream SessionSidePanel has no unused SyncProvider dependency", async () => {
    const text = await Bun.file(path.join(root, "app/workbench/content/context-content.tsx")).text()

    expect(await Bun.file(path.join(root, "pages/session/session-side-panel.tsx")).exists()).toBe(false)
    expect(text).toMatch(/SessionPaneScope/)
    expect(text).toMatch(/SessionConversationOwner/)
    expect(text).toMatch(/<SessionContextTab/)
    expect(text).not.toMatch(/\buseSync\b/)
    expect(text).not.toMatch(/sync\./)
  })

  test("the legacy upstream titlebar stays deleted", async () => {
    // Replaced by workbench-shell-header + titlebar-drag-region in the shell
    // rewrite; the file was dead weight the orphan guard flagged once its last
    // re-export left the entry barrel.
    expect(await Bun.file(path.join(root, "app/workbench/titlebar/titlebar.tsx")).exists()).toBe(false)
  })

  test("MCP and LSP status is owned by the runtime backend, with no upstream status surface left", async () => {
    const backend = await Bun.file(path.join(root, "platform/runtime/http-backend.ts")).text()
    const sessionPortsText = await Bun.file(path.join(root, "features/session/app-ports.ts")).text()
    const claxedoSessionHeader = await Bun.file(path.join(root, sessionHeader)).text()
    const selectMcp = await Bun.file(path.join(root, "features/agent-plugins/mcp/catalog-dialog.tsx")).text()

    // Neither override copy nor `app/connection/status-popover.tsx` may exist,
    // and session app-ports must not pin a type to any of them.
    expect(await Bun.file(path.join(root, "overrides/components/dialog-select-mcp-logic.ts")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "overrides/components/dialog-select-mcp.tsx")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "overrides/app/connection/status-popover.tsx")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "app/connection/status-popover.tsx")).exists()).toBe(false)
    // The `/mcp` dialog browses the Agent Plugins catalog and posts the same
    // revision-guarded activation the Directory does; it owns no install state.
    expect(selectMcp).toMatch(/from "@\/features\/agent-plugins\/api"/)
    expect(selectMcp).toMatch(/props\.api\.activation\(/)
    expect(selectMcp).toMatch(/withCurrentRevision\(/)
    expect(sessionPortsText).not.toMatch(/StatusPopover/)
    expect(sessionPortsText).not.toMatch(/marketplace/)
    expect(claxedoSessionHeader).not.toMatch(/StatusPopover/)
    expect(claxedoSessionHeader).not.toMatch(/\.\.\/status-popover/)

    // The status itself still has an owner: the runtime backend reads it per
    // directory, so no UI surface grows its own directory-scoped query.
    expect(backend).toMatch(/getMcpStatus: async/)
    expect(claxedoSessionHeader).not.toMatch(/directoryMcpQuery/)
  })

  test("legacy SyncProvider bridge is deleted after DataProvider cutover", async () => {
    const directoryScopeText = await Bun.file(path.join(root, directoryScope)).text()
    const controllerText = await Bun.file(path.join(root, sessionController)).text()

    expect(await Bun.file(path.join(root, syncContext)).exists()).toBe(false)
    expect(directoryScopeText).toMatch(/DirectoryDataProvider/)
    expect(directoryScopeText).not.toMatch(/fetchSessionMessagesByTransport/)
    expect(directoryScopeText).not.toMatch(/hydrateConversationPage/)
    expect(directoryScopeText).not.toMatch(/limit:\s*80/)
    expect(controllerText).toMatch(/hydrateConversationPage/)
    expect(controllerText).not.toMatch(/\buseSync\b/)
    expect(controllerText).not.toMatch(/sync\.session/)
  })

  test("global-sync dispatches conversation events to registered chat owners", async () => {
    const text = await Bun.file(path.join(root, "app/integrations/session-events/event-router.ts")).text()

    expect(text).toMatch(/applyRegisteredConversationEvent/)
    expect(text).toMatch(/applyDirectoryEventToShellQueries/)
    expect(text).toMatch(/applyDirectorySessionCacheEvent/)
  })

  test("PromptInput resolves session identity without router params", async () => {
    const text = await Bun.file(path.join(root, promptInput)).text()
    const submit = await Bun.file(path.join(root, promptSubmit)).text()
    const submitUiState = await Bun.file(
      path.join(root, "features/session/composer/ui/submit-ui-state.ts"),
    ).text()
    const submitInput = await Bun.file(path.join(root, promptSubmitInput)).text()
    const props = await Bun.file(path.join(root, "features/session/composer/prompt-input-props.ts")).text()
    const toolbar = await Bun.file(path.join(root, promptToolbarState)).text()
    const submitCreate = await Bun.file(path.join(root, "features/session/composer/ui/submit-create-session.ts")).text()
    const workspaceResolver = await Bun.file(path.join(root, "features/session/composer/workspace-resolver.ts")).text()

    expect(text).not.toMatch(/@solidjs\/router/)
    expect(text).not.toMatch(/\buseParams\b/)
    expect(text).not.toMatch(/not in split mode/)
    expect(text).toMatch(/const sessionParams = useSessionParams\(\)/)
    expect(props).toMatch(/mode:\s*ComposerMode/)
    expect(text).toMatch(/const composerMode = createMemo\(\(\) => props\.mode\)/)
    expect(text).toMatch(/composerModeSnapshot/)
    expect(text).toMatch(/const resolvedSessionId = \(\) => modeSnapshot\(\)\.sessionId/)
    expect(text).toMatch(/surfaceId:\s*sessionParams\.surfaceId\?\.\(\)/)
    expect(text).not.toMatch(/sync\.data\.message/)
    expect(text).not.toMatch(/sync\.data\.session_status/)
    expect(text).not.toMatch(/sync\.data\.session_status_meta/)
    expect(text).not.toMatch(/sync\.project/)
    expect(text).not.toMatch(/\buseSync\b/)
    expect(text).toMatch(/queryOptions\.projects\(\)/)
    // Agents come through the session-selection provider (useLocal), whose
    // module owns the agentListQuery read — no sync.data.agent mirror.
    expect(text).toMatch(/local\.agent\.list/)
    expect(await Bun.file(path.join(root, localContextOwner)).text()).toMatch(/agentListQuery/)
    expect(text).toMatch(/directorySessionCacheQueryOptions/)
    expect(text).not.toMatch(/sync\.session\.get/)
    expect(text).not.toMatch(/sync\.data\.(?:agent|permission|question|session_diff)/)
    expect(props).toMatch(/activeTurn\?:\s*\(\) => boolean/)
    expect(props).toMatch(/diffFiles\?:\s*\(\) => readonly string\[\]/)
    expect(text).toMatch(/promptSessionStatusStage/)
    expect(text).toMatch(/registeredConversationHasUserMessage/)
    expect(toolbar).toMatch(/promptModelResolutionState/)
    expect(text).not.toMatch(/fallbackGuardScopeKey/)
    expect(text).not.toMatch(/\$\{sessionParams\.directory\(\)\}::\$\{sessionParams\.sessionId\(\) \?\? "draft"\}/)
    expect(submit).not.toMatch(/\buseSessionParams\b/)
    expect(submit).not.toMatch(/\buseSync\b/)
    expect(submit).not.toMatch(/sync\.session\.optimistic/)
    expect(submit).not.toMatch(/not in workbench context/)
    expect(submit).not.toMatch(/globalSync\.child/)
    expect(submit).not.toMatch(/globalSync\.todo\.set/)
    expect(submit).not.toMatch(/setPromptSessionStatus\(\{\s*setStore/)
    expect(submit).not.toMatch(/setStore\("todo"/)
    expect(submit).not.toMatch(/setStore\("(?:permission|question)"/)
    expect(submit).not.toMatch(/sessionRefForPane/)
    expect(submit).not.toMatch(/sessionContentPayload/)
    expect(submit).not.toMatch(/sessionRefForSession/)
    expect(submitCreate).toMatch(/sessionRefForSubmitTarget/)
    expect(workspaceResolver).toMatch(/sessionRefForSubmitTarget/)
    expect(workspaceResolver).toMatch(/sessionRefForWorkspaceSession/)
    expect(submitCreate).toMatch(/sessionWorkspaceRuntimeRef/)
    expect(submitCreate).toMatch(/content\?\.sessionRef/)
    expect(submitUiState).toMatch(/addRegisteredConversationMessage\(item\)/)
    expect(submitUiState).toMatch(/removeRegisteredConversationMessage\(item\)/)
    expect(submit).not.toMatch(/setQueryData\(shellDataKeys\.sessionId\(sessionID, "requests"\)/)
    expect(submitInput).toMatch(/surfaceId\?:\s*Accessor<string \| undefined>/)
  })

  test("prompt send phase routes status through shell queries, not the Solid mirror", async () => {
    const pending = await Bun.file(path.join(root, promptSubmitPending)).text()
    const send = await Bun.file(path.join(root, promptSubmitSend)).text()
    const types = await Bun.file(path.join(root, promptSubmitTypes)).text()

    expect(pending).toMatch(/dispatchSessionStatusEvent/)
    expect(pending).not.toMatch(/SetStoreFunction/)
    expect(pending).not.toMatch(/setStore/)
    expect(send).not.toMatch(/setPromptSessionStatus\(\{[\s\S]*setStore/)
    expect(types).not.toMatch(/SetStoreFunction/)
    expect(types).not.toMatch(/setStore\?:/)
    expect(types).not.toMatch(/setStore:/)
    expect(send).toMatch(/setPromptSessionStatus\(\{[\s\S]*refreshDirectory: input\.refreshDirectory/)
    const submit = await Bun.file(path.join(root, promptSubmit)).text()
    const transport = await Bun.file(path.join(root, "features/session/composer/ui/submit-transport.ts")).text()
    expect(submit).toMatch(/useDirectorySessionCacheActions/)
    expect(submit).toMatch(/directorySessionCacheActions\.refresh/)
    expect(submit).toMatch(/workspaceRuntimeRef/)
    expect(transport).toMatch(/sessionWorkspaceRuntimeRef/)
    expect(submit).not.toMatch(/workspaceIdFromDirectoryRef/)
  })

  test("Terminal component is first-party, not override-owned", async () => {
    const text = await Bun.file(path.join(root, terminalComponent)).text()

    expect(await Bun.file(path.join(root, "overrides/features/terminal/ui/terminal.tsx")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, terminalComponent)).exists()).toBe(true)
    expect(text).toMatch(/createTerminalPtyClient/)
    expect(text).toMatch(/resolveWorkspaceRuntime/)
    expect(text).toMatch(/@\/platform\/runtime\/platform-provider/)
    expect(text).not.toMatch(/@\/context\/platform/)
    expect(text).toMatch(/@\/platform\/i18n\/provider/)
    expect(text).not.toMatch(/\.\.\/\.\.\/utils\/api/)
    expect(text).not.toMatch(/\.\.\/\.\.\/cloud\/runtime\/workspace-runtime-store/)
    // The entry barrel does not re-export Terminal;
    // pane consumers mount it through the first-party RoleGuardedTerminal
    // wrapper, which resolves to @/features/terminal/ui/terminal, never an
    // override.
    expect(await Bun.file(path.join(root, "app/entry/index.tsx")).text()).not.toMatch(
      /@\/features\/terminal\/ui\/terminal/,
    )
    expect(await Bun.file(path.join(root, "features/terminal/ui/content/terminal-content.tsx")).text()).toMatch(
      /role-guarded-terminal/,
    )
    const processPanel = await Bun.file(
      path.join(root, "features/processes/ui/workspace-panel/process-pane-panel.tsx"),
    ).text()
    const reviewWorkspace = await Bun.file(path.join(root, "app/workbench/review/review-workspace.tsx")).text()
    // The RoleGuardedTerminal mount lives in review-workspace-process-section.tsx,
    // the process pane split out of review-workspace.
    const reviewProcessSection = await Bun.file(
      path.join(root, "app/workbench/review/review-workspace-process-section.tsx"),
    ).text()
    expect(processPanel).toMatch(/renderTerminal\?:/)
    expect(processPanel).not.toMatch(/role-guarded-terminal/)
    expect(reviewWorkspace).toMatch(/<ReviewWorkspaceProcessSection/)
    expect(reviewProcessSection).toMatch(/RoleGuardedTerminal/)
    expect(reviewProcessSection).toMatch(/renderTerminal=/)
    const roleGuard = await Bun.file(path.join(root, roleGuardedTerminal)).text()
    expect(roleGuard).toMatch(/import \{[^}]*\bTerminal\b[^}]*\} from "\.\.\/ui\/terminal"/)
    expect(await Bun.file(path.join(root, "overrides/features/terminal/core/role-guarded-terminal.tsx")).exists()).toBe(
      false,
    )
  })

  test("directory-layout route is a pass-through — no per-workspace provider tree (rubric C4)", async () => {
    const directoryLayout = await Bun.file(path.join(root, "app/routes/directory-layout.tsx")).text()
    const app = await Bun.file(path.join(root, "app/entry/app.tsx")).text()

    expect(app).toMatch(/@\/app\/routes\/directory-layout/)
    expect(app).not.toMatch(/@\/pages\/directory-layout/)
    expect(await Bun.file(path.join(root, "overrides/app/routes/directory-layout.tsx")).exists()).toBe(false)
    // These providers are owned by Workbench DirectoryScope. Re-mounting
    // them at the route level around the hidden outlet wastes lifecycle
    // work for every active workspace.
    for (const provider of [
      "WorkspaceSDKProvider",
      "SyncProvider",
      "DataProvider",
      "TerminalProvider",
      "FileProvider",
      "PromptProvider",
      "CommentsProvider",
      "LocalProvider",
    ]) {
      expect(directoryLayout).not.toMatch(new RegExp("<" + provider))
    }
  })

  test("SessionHeader portals Share for signed authority-backed workspace sessions", async () => {
    const text = await Bun.file(path.join(root, sessionHeader)).text()

    expect(
      await Bun.file(path.join(root, "overrides/features/session/ui/components/session-header.tsx")).exists(),
    ).toBe(false)
    expect(text).toMatch(/SessionPeopleControl/)
    expect(text).toMatch(/shareTarget/)
    expect(text).not.toMatch(/host !== "central"/)
    expect(text).toMatch(/workspaceKey\(sessionRef\)/)
    expect(text).toMatch(/status !== "signed"/)
    expect(text).not.toMatch(/StatusPopover/)
    expect(text).not.toMatch(/terminal\.toggle/)
    expect(text).not.toMatch(/review\.toggle/)
    expect(text).not.toMatch(/fileTree\.toggle/)
    expect(text).not.toMatch(/OPEN_PATH_REQUEST_TIMEOUT_MS/)
    expect(text).not.toMatch(/openDir/)
    expect(text).not.toMatch(/OPEN_APPS/)
    expect(text).not.toMatch(/createActiveConversationSnapshot/)
    expect(text).not.toMatch(/messageAgentColor/)
    expect(text).not.toMatch(/\buseSync\b/)
    expect(text).not.toMatch(/sync\.data\.message/)
  })

  test("ReviewTab keeps VCS payloads query-owned without mount-time status fetches", async () => {
    const text = await Bun.file(path.join(root, reviewTab)).text()
    const cache = await Bun.file(path.join(root, "features/review/ui/review-vcs-cache.ts")).text()
    // The diff-summary loader lives in review-vcs-load.ts and is exposed as
    // query options: ReviewTab OBSERVES them, so the directory-scoped
    // invalidation in review-vcs-invalidation.ts reaches the surface on screen
    // instead of only the next mount.
    const vcsLoad = await Bun.file(path.join(root, "features/review/ui/review-vcs-load.ts")).text()
    const vcsInvalidation = await Bun.file(path.join(root, "features/review/ui/review-vcs-invalidation.ts")).text()

    expect(text).toMatch(/reviewVcsDiffSummaryQueryOptions/)
    expect(text).toMatch(/useQuery/)
    expect(text).not.toMatch(/remoteDiffKey/)
    expect(vcsLoad).toMatch(/cachedReviewVcsDiff/)
    expect(vcsLoad).toMatch(/fetchReviewVcsDiffSummary/)
    expect(cache).toMatch(/invalidateReviewVcsDirectory[\s\S]*?invalidateQueries/)
    expect(text).toMatch(/cachedReviewVcsFile/)
    expect(text).toMatch(/cachedReviewVcsRefs/)
    expect(text).toMatch(/cachedReviewVcsTargets/)
    expect(text).toMatch(/restoredOpenDiffs/)
    expect(text).not.toMatch(/initialReviewOpenDiffs/)
    expect(text).toMatch(/onDiffContentRequired/)
    expect(text).toMatch(/afterVisibleWork/)
    expect(vcsInvalidation).toMatch(/event\.type === "session\.status"/)
    for (const source of [text, vcsLoad, vcsInvalidation]) {
      expect(source).not.toMatch(/sessionStatusQueryOptions/)
    }
    expect(text).not.toMatch(/initialReviewContentPrefetchFiles/)
    expect(text).toMatch(/data-review-diff-style/)
    expect(text).toMatch(/event\.key\.toLowerCase\(\) !== "d"/)
    expect(cache).toMatch(/"review-vcs-diff"/)
    expect(cache).toMatch(/"review-vcs-file"/)
    expect(cache).toMatch(/"review-vcs-refs"/)
    expect(cache).toMatch(/"review-vcs-targets"/)
    for (const source of [text, vcsLoad]) {
      expect(source).not.toMatch(/vcsDiffCache = new Map/)
      expect(source).not.toMatch(/vcsDiffInflight = new Map/)
      expect(source).not.toMatch(/vcsFileCache = new Map/)
      expect(source).not.toMatch(/vcsFileInflight = new Map/)
    }
    for (const source of [text, vcsLoad, vcsInvalidation]) {
      expect(source).not.toMatch(/\buseSync\b/)
      expect(source).not.toMatch(/sync\.data\.session_status/)
    }
  })

  test("workspace files navigator exposes stable row selectors for browser performance", async () => {
    const navigator = await Bun.file(path.join(root, "app/workbench/workspace-panel/files-navigator.tsx")).text()
    const fileTree = await Bun.file(path.join(root, "app/workbench/controls/file-tree.tsx")).text()

    expect(navigator).toMatch(/data-testid="workspace-files-navigator"/)
    expect(navigator).toMatch(/data-file-tree-shell-ready=\{fileTreeShellReady\(\) \? "true" : undefined\}/)
    expect(navigator).toMatch(/data-file-tree-data-ready=\{fileTreeDataReady\(\) \? "true" : undefined\}/)
    expect(navigator).not.toMatch(/"changes"/)
    expect(fileTree).toMatch(/data-file-tree-path=\{node\.path\}/)
  })

  test("workspace chrome keeps sidebar and navigator controls in stable layout lanes", async () => {
    const sidebarShell = await Bun.file(path.join(root, railSidebarShell)).text()
    const workbenchShell = await Bun.file(path.join(root, railWorkbenchShell)).text()
    const header = await Bun.file(path.join(root, "app/workbench/rail/workbench-shell-header.tsx")).text()
    const panelVisual = await Bun.file(path.join(root, "app/workbench/rail/workspace-panel-visual-state.ts")).text()
    const panelMotion = await Bun.file(path.join(root, "app/workbench/rail/workspace-panel-motion-state.ts")).text()
    const keyboardController = await Bun.file(path.join(root, "app/workbench/rail/rail-keyboard-controller.tsx")).text()
    const floatingChromeMarkup =
      header.match(/data-testid="workspace-panel-floating-chrome"[\s\S]*?<WorkspacePanelChrome/)?.[0] ?? ""
    const floatingDomBlock =
      panelMotion.match(
        /if \(floatingChrome\) \{[\s\S]*?floatingChrome\.style\.pointerEvents = "auto"[\s\S]*?\n    \}/,
      )?.[0] ?? ""

    expect(sidebarShell).toMatch(/--claxedo-sidebar-width/)
    expect(sidebarShell).toMatch(/w-\[var\(--claxedo-sidebar-width\)\] shrink-0/)
    expect(sidebarShell).toMatch(
      /props\.sidebarPinned\(\) \? "" : "md:absolute md:left-0 md:top-0 md:bottom-0 md:z-\[80\]"/,
    )
    expect(sidebarShell).toMatch(/max-md:fixed/)
    expect(sidebarShell).not.toMatch(/absolute top-0 left-0 bottom-0 z-\[100\]/)
    expect(sidebarShell).toMatch(/props\.closeMobileSidebar\(\)/)
    expect(workbenchShell).toMatch(/data-testid="workbench-column"/)
    expect(workbenchShell).toMatch(/onWorkspacePanelWorkbenchColumnRef/)
    // The panel's settle gate holds content construction until the opening
    // motion ends, and this column's transition IS that motion. The gate is
    // handed the property by name, so the name and the class that animates it
    // must not drift apart — a silent drift would un-track the open entirely.
    const columnMotionProperty = workbenchShell.match(
      /const WORKBENCH_COLUMN_MOTION_PROPERTY = "([^"]+)"/,
    )?.[1]
    expect(columnMotionProperty).toBeTruthy()
    expect(workbenchShell).toMatch(
      new RegExp(`data-testid="workbench-column"[\\s\\S]{0,400}transition-\\[${columnMotionProperty}\\]`),
    )
    expect(workbenchShell).toMatch(/openMotion=\{\(\) => \(\{ element: workbenchColumn, property: WORKBENCH_COLUMN_MOTION_PROPERTY \}\)\}/)
    expect(workbenchShell).toMatch(/onWorkspacePanelWidthChange/)
    expect(workbenchShell).not.toMatch(/workspacePanelLiveWidth/)
    expect(workbenchShell).toMatch(/onWorkspacePanelFloatingChromeRef/)
    expect(workbenchShell).toMatch(/onWorkspacePanelShellRef/)
    expect(workbenchShell).not.toMatch(/__claxedoWorkspacePanel/)
    expect(panelVisual).toMatch(/registerWorkspacePanelFloatingChrome/)
    expect(panelVisual).toMatch(/registerWorkspacePanelShell/)
    expect(panelVisual).toMatch(/registerWorkspacePanelWorkbenchColumn/)
    expect(panelMotion).not.toMatch(/__claxedoWorkspacePanel/)
    expect(panelMotion).not.toMatch(/document\.querySelector/)
    expect(panelMotion).toMatch(/registerWorkbenchColumn/)
    expect(keyboardController).toMatch(/toggleSidebar: input\.toggleSidebar/)
    expect(keyboardController).not.toMatch(/state\.rail\.toggle/)
    expect(workbenchShell).toMatch(/<RailWorkbenchCanvas/)
    expect(workbenchShell).toMatch(/<RailWorkspacePanelShell/)
    expect(workbenchShell).toMatch(
      /<Show when=\{props\.mountWorkspacePanel !== false && props\.workspacePanelMounted\(\)\}>/,
    )
    expect(workbenchShell).toMatch(/<div class="hidden">\{props\.children\}<\/div>/)
    expect(header).toMatch(/data-testid="workspace-panel-floating-chrome"[\s\S]{0,220}absolute inset-y-0 right-1/)
    expect(floatingChromeMarkup).toContain("<WorkspacePanelChrome")
    expect(floatingChromeMarkup).not.toMatch(/icon="file-tree"/)
    expect(floatingChromeMarkup).not.toMatch(/-translate-y-1\/2/)
    expect(floatingDomBlock).toContain("floatingChrome.style.display")
    expect(floatingDomBlock).not.toMatch(/style\.transform/)
  })

  test("RailSidebar composes session-list and terminal islands with decoration-only status hydration", async () => {
    const text = await Bun.file(path.join(root, railSidebar)).text()
    const layout = await Bun.file(path.join(root, appShellLayout)).text()
    const headerSurfaces = await Bun.file(path.join(root, "app/workbench/rail/rail-header-surfaces.ts")).text()
    const projectSessionInfo = await Bun.file(path.join(root, "app/workbench/rail/rail-project-session-info.ts")).text()
    const sessionStatusDispatcher = await Bun.file(
      path.join(root, "features/session/store/session-status-dispatcher.ts"),
    ).text()
    const sidebarDataPlane = `${text}\n${headerSurfaces}\n${projectSessionInfo}`

    // Each section reads its own SOURCE, chosen from the catalog row's host
    // kind: the attached server for a workspace it or the provisioner holds and
    // for Global Chat, the workspace's own runtime over the relay for one
    // another machine serves. The rail never names a list route itself.
    const sectionList = await Bun.file(
      path.join(root, "app/workbench/rail/rail-section-session-list.ts"),
    ).text()
    expect(text).toMatch(/createRailSectionSessionList/)
    expect(text).toMatch(/sessionSourceForWorkspace/)
    // A project section lists every workspace in it, so its source is the
    // composition of theirs — never the central server alone.
    expect(text).toMatch(/projectSessionSource/)
    expect(text).not.toMatch(/sessionListQueryOptions/)
    expect(sectionList).toMatch(/sessionSourceQueryOptions/)
    expect(text).not.toMatch(/claxedoState\.rail/)
    expect(text).toMatch(/<SessionNavigation/)
    expect(text).toMatch(/<TerminalSurfaceNavigation/)
    expect(text).toMatch(/function SessionListNotice/)
    expect(text).toMatch(/rail-sidebar-session-list-\$\{props\.variant\}/)
    expect(text).toMatch(/loadingInitial/)
    expect(text).toMatch(/sessionListLoadingMore/)
    expect(text).toMatch(/sessionListPageError/)
    expect(text).toMatch(/actionLabel="Retry"/)
    expect(text).toMatch(/doneLoaded/)
    expect(text).toMatch(/visibleSessionRowsBySection/)
    expect(text).toMatch(/registerVisibleSessionRows/)
    expect(text).toMatch(/Object\.values\(visibleSessionRowsBySection\(\)\)\.flat\(\)/)
    expect(text).toMatch(/visibleSessionRows\(\)\.map/)
    expect(text).toMatch(/deriveTerminalSurfaceRows/)
    expect(text).toMatch(/function sessionNavigationRefForRow\(session: Row\)/)
    expect(text).toMatch(/sessionNavigationRefForRow\(session\)/)
    expect(text).toMatch(/sessionInventoryQueryOptions/)
    // The rail's canonical entry writes go through the one directory-payload
    // owner (directory-session-meta.ts) and only for the focused row; every
    // other row stays a decoration-local signal. The dispatch into the shell
    // query cache lives with that owner.
    expect(text).toMatch(/publishFocusedRailSessionMeta/)
    expect(text).toMatch(/applyDirectorySessionMeta/)
    const directorySessionMeta = await Bun.file(
      path.join(root, "features/session/store/directory-session-meta.ts"),
    ).text()
    expect(directorySessionMeta).toMatch(/dispatchSessionStatusEvent/)
    expect(directorySessionMeta).toMatch(/dispatchSessionRequestsEvent/)
    expect(sessionStatusDispatcher).toMatch(/setSessionStatusQueryData as writeSessionStatusQueryData/)
    expect(sessionStatusDispatcher).toMatch(/setSessionRequestsQueryData as writeSessionRequestsQueryData/)
    expect(text).toMatch(/client\.session\.status\(/)
    expect(text).toMatch(/client\.permission\.list\(/)
    expect(text).toMatch(/client\.question\.list\(/)
    expect(text).not.toMatch(/directorySessionCacheQueryOptions/)
    expect(text).not.toMatch(/const directorySessionQuery = useQuery/)
    expect(text).not.toMatch(/cachedSessionRow/)
    expect(text).not.toMatch(/activeSessionInventoryRow/)
    expect(text).not.toMatch(/projectSessionInventoryRows/)
    expect(text).not.toMatch(/loadMoreWorkspaceSessions/)
    expect(text).not.toMatch(/loadMoreDirectoryCacheSessions/)
    expect(text).not.toMatch(/loadMoreProjectSessions/)
    expect(text).not.toMatch(/revealMountedWorkbenchContent/)
    expect(text).toMatch(/sessionStatusTargetSignature/)
    // Session history begins only from the trusted activation path; opening a
    // rail section must not warm unrelated transcript or surface state.
    expect(text).not.toMatch(/preload/)
    expect(text).not.toMatch(/sameWorkspaceSessionPrefetchIds/)
    expect(text).not.toMatch(/neighborPrefetchScheduler/)
    expect(text).not.toMatch(/function sessionStatusKey/)
    expect(text).not.toMatch(/return sessionID/)
    expect(text).not.toMatch(/store\.session_status/)
    expect(text).not.toMatch(/store\.(?:permission|question)/)
    expect(text).not.toMatch(/globalSync\.sessionInventory\.store/)
    expect(text).not.toMatch(/seen\.has\(session\.id\)/)
    expect(text).not.toMatch(/seen\.add\(session\.id\)/)
    const diagnostics = await Bun.file(path.join(root, "features/processes/ui/dialog-process-diagnostics.tsx")).text()
    expect(diagnostics).toMatch(/usePlatform\(\)\.processDiagnostics/)
    expect(diagnostics).not.toMatch(/bySession\.set\(`\$\{tab\.directory\}:\$\{tab\.sessionId\}`/)
    expect(headerSurfaces).toMatch(/subscribeSessionActivity/)
    expect(headerSurfaces).not.toMatch(/sessionStatusQueryOptions/)
    expect(projectSessionInfo).toMatch(/directorySessionCacheQueryOptions/)
    expect(projectSessionInfo).toMatch(/sessionInventoryQueryOptions/)
    expect(projectSessionInfo).toMatch(/queryClient\.getQueryData/)
    expect(layout).toMatch(/useRailProjectSessionInfo/)
    expect(layout).not.toMatch(/store\.session_status/)
    expect(sidebarDataPlane).not.toMatch(/globalSync\.sessionInventory\.store/)
    expect(sidebarDataPlane).not.toMatch(/useQueryOptions/)
    expect(sidebarDataPlane).not.toMatch(/queryOptions\.projects\(\)/)
    expect(sidebarDataPlane).not.toMatch(/globalSync\.data\.project/)
  })

  test("empty workbench opens the real draft-session composer path", async () => {
    const text = await Bun.file(path.join(root, appShellLayout)).text()
    const canvas = await Bun.file(path.join(root, "app/workbench/rail/rail-workbench-canvas.tsx")).text()
    const controller = await Bun.file(path.join(root, "app/workbench/rail/rail-empty-draft-controller.ts")).text()

    expect(controller).toMatch(/renderableSurfaceIds/)
    expect(controller).toMatch(/visibleRenderableSurfaceIds/)
    expect(controller).toMatch(/input\.state\.meta\.get\(id\)/)
    expect(controller).toMatch(/focusedSurface/)
    expect(controller).toMatch(/emptyDraftDirectory/)
    expect(controller).toMatch(/shouldOpenEmptyDraftSession/)
    expect(text).toMatch(/suppressEmptyDraftSession/)
    expect(controller).toMatch(/autoOpenDisabled/)
    expect(controller).toMatch(/blockNextAutoOpen/)
    expect(controller).toMatch(/queueMicrotask/)
    expect(controller).not.toMatch(/createRenderEffect/)
    expect(controller).toMatch(/visibleRenderableSurfaceIds\(\)\.length > 0/)
    expect(controller).toMatch(/return !focusedSurface\(\)/)
    expect(controller).toMatch(/input\.onNewSession\?\.\(emptyDraftDirectory\(\)\)/)
    expect(canvas).toMatch(/EmptyDraftSessionComposer/)
    expect(canvas).toMatch(/empty-draft-session-composer/)
    expect(canvas).toMatch(/<SessionContent/)
    expect(canvas).toMatch(/fallbackDirectory=\{props\.emptyDraftDirectory\}/)
    expect(canvas).not.toMatch(/Select a session or create a new one/)
    expect(canvas).not.toMatch(/Opening new session/)
    expect(controller).not.toMatch(/panes\.length === 1/)
  })

  test("boot-time layout state does not write equivalent state back into Solid", async () => {
    const rail = await Bun.file(path.join(root, appShellLayout)).text()
    const provider = await Bun.file(path.join(root, "app/workbench/state/provider.tsx")).text()
    const workspacePanel = await Bun.file(path.join(root, "app/workbench/state/workspace-panel.ts")).text()

    expect(rail).not.toMatch(/didAutoOpenRail/)
    expect(rail).not.toMatch(/claxedoState\.rail\.pin\(\)/)
    // sameWorkbenchState split into per-slice comparators so the onChange
    // pipe patches only changed top-level slices; the equivalent-state
    // early-return survives as the all-slices-unchanged guard.
    expect(provider).toMatch(/function samePanes/)
    expect(provider).toMatch(/function sameSplit/)
    expect(provider).toMatch(/function sameSnapshots/)
    expect(provider).toMatch(
      /if \(\s*!focusedPaneChanged &&\s*!panesChanged &&\s*!splitChanged &&\s*!contentIdsChanged &&\s*!contentRecencyChanged &&\s*!snapshotsChanged\s*\) return/,
    )
    expect(provider).not.toMatch(/sameWorkbenchState/)
    expect(workspacePanel).toMatch(/function samePanelState/)
    expect(workspacePanel).toMatch(/const replacePanel = \(next: WorkspacePanelState\) => \{/)
    expect(workspacePanel).toMatch(/if \(samePanelState\(state\.workspacePanel, next\)\) return/)
    expect(workspacePanel).toMatch(/if \(!state\.workspacePanel\.open\) return/)
    expect(workspacePanel).toMatch(/if \(current\.mode === mode\) return/)
    expect(workspacePanel).toMatch(/if \(state\.workspacePanel\.navigatorHidden === hidden\) return/)
  })

  test("upstream sidebar permission badges read shell request queries", async () => {
    const text = await Bun.file(path.join(root, railSidebar)).text()
    const helper = await Bun.file(path.join(root, directorySessionCache)).text()

    expect(helper).toMatch(/directorySessionCacheQueryOptions\(\{ directory \}\)/)
    expect(helper).toMatch(/DirectorySessionCacheValue/)
    // Batch freshness bookkeeping lives in rail-sidebar-status.ts, and the shell
    // "requests" query reads in the one directory-payload owner
    // (directory-session-meta.ts, absent-means-keep merge) plus the header
    // surface reader (rail-header-surfaces.ts); the badges invariant spans that set.
    const statusHelper = await Bun.file(path.join(root, "app/workbench/rail/rail-sidebar-status.ts")).text()
    const headerSurfaces = await Bun.file(path.join(root, "app/workbench/rail/rail-header-surfaces.ts")).text()
    const directorySessionMeta = await Bun.file(
      path.join(root, "features/session/store/directory-session-meta.ts"),
    ).text()
    expect(statusHelper).toMatch(/SIDEBAR_SESSION_STATUS_FRESH_MS = 10_000/)
    expect(statusHelper).toMatch(/sidebarSessionStatusBatches = new Map/)
    expect(headerSurfaces).toMatch(/queryClient\.getQueryData<SessionRequestsQueryData>\(shellDataKeys\.sessionId\(id, "requests"\)\)/)
    expect(directorySessionMeta).toMatch(/shellDataKeys\.sessionId\(input\.sessionID, "requests"\)/)
    for (const source of [text, statusHelper, headerSurfaces, directorySessionMeta]) {
      expect(source).not.toMatch(/useGlobalSync/)
      expect(source).not.toMatch(/globalSync\.child/)
      expect(source).not.toMatch(/sessionStore\.session/)
      expect(source).not.toMatch(/store\.permission/)
      expect(source).not.toMatch(/sessionStore\.permission/)
      expect(source).not.toMatch(/sessionStore\.agent/)
    }
  })

  test("upstream workspace sidebar reads session inventory from directory cache queries", async () => {
    const text = await Bun.file(path.join(root, railSidebar)).text()
    const helper = await Bun.file(path.join(root, directorySessionCache)).text()
    const projectInfo = await Bun.file(path.join(root, "app/workbench/rail/rail-project-session-info.ts")).text()
    const globalSync = await Bun.file(path.join(root, globalSyncContext)).text()

    expect(helper).toMatch(/directorySessionCacheQuery\(directory: string\)/)
    expect(helper).toMatch(/directorySessionCacheQueryOptions\(\{ directory \}\)/)
    expect(helper).not.toMatch(/increaseDirectorySessionLimit/)
    expect(projectInfo).toMatch(/directorySessionCacheQueryOptions\(\{ directory \}\)\.queryKey/)
    expect(projectInfo).toMatch(/queryClient\.getQueryData<DirectorySessionCacheValue>/)
    expect(projectInfo).toMatch(/function cachedDirectorySessions\(directory: string\)/)
    expect(projectInfo).toMatch(/\?\.\s*session \?\? \[\]/)
    expect(text).not.toMatch(/useGlobalSync/)
    expect(text).not.toMatch(/globalSync\.project\.loadSessions/)
    expect(text).not.toMatch(/globalSync\.child/)
    expect(globalSync).toMatch(/function sessionCacheLimit\(directory: string, fallback: number\)/)
    expect(globalSync).toMatch(/queryKeys\.directory\.sessionCache\(key\)/)
    expect(globalSync).toMatch(
      /queryClient\.getQueryData<SessionCacheValue>\(queryKeys\.directory\.sessionCache\(directory\)\)\?\.limit/,
    )
    expect(globalSync).toMatch(/function cacheSessions\(directory: string, value: Omit<SessionCacheValue, "at">\)/)
    expect(text).not.toMatch(/sortedRootSessions\(workspaceStore/)
    expect(text).not.toMatch(/workspaceStore\.sessionTotal/)
    expect(text).not.toMatch(/workspace\(\)\.store/)
    expect(text).not.toMatch(/setStore\("limit"/)
    expect(text).not.toMatch(/setWorkspaceStore\("limit"/)
  })

  test("upstream directory picker ranks recent projects from directory session cache", async () => {
    const text = await Bun.file(path.join(root, "app/dialogs/select-directory.tsx")).text()

    expect(text).toMatch(/cachedDirectoryChildrenRequest/)
    expect(text).toMatch(/const recentProjects = createMemo/)
    expect(text).toMatch(/layout\.projects\.list\(\)\.slice\(0, 5\)/)
    expect(text).toMatch(/uniqueRows\(\[\.\.\.recentProjects\(\),/)
    expect(text).not.toMatch(/const cache = new Map/)
    expect(text).not.toMatch(/cache\.(?:get|set)/)
    expect(text).not.toMatch(/sync\.child\(directory/)
    expect(text).not.toMatch(/\.session\s*$/m)
  })

  test("upstream file picker labels workspaces from runtime VCS cache", async () => {
    const text = await Bun.file(path.join(root, dialogSelectFile)).text()

    expect(text).not.toMatch(/cachedRuntimeVcs/)
    expect(text).not.toMatch(/runtime-vcs-cache/)
    expect(text).not.toMatch(/globalSync\.child\(directory/)
    expect(text).not.toMatch(/store\.vcs/)
  })

  test("upstream notification lookup reads directory session cache before network fallback", async () => {
    const text = await Bun.file(path.join(root, notificationContext)).text()

    expect(text).toMatch(/directorySessions\(input\.directory\)\.find\(\(item\) => item\.id === input\.sessionID\)/)
    expect(text).toMatch(/input\.getSession\(\{[\s\S]*directory: input\.directory,[\s\S]*sessionID: input\.sessionID/)
    expect(text).toMatch(/upsertDirectorySession\(input\.directory, session\)/)
    expect(text).toMatch(/getSession:\s*\(parameters\) => globalSDK\.createClient\(\{ directory \}\)\.session\.get\(parameters\)/)
    expect(text).toMatch(/if \(meta\.disposed \|\| !session \|\| session\.parentID\) return/)
    expect(text).not.toMatch(/useGlobalSync/)
    expect(text).not.toMatch(/globalSync\.child/)
    expect(text).not.toMatch(/syncStore\.session/)
  })

  test("upstream directory sync compatibility adapter has been retired", async () => {
    const helper = await Bun.file(path.join(root, directorySessionCache)).text()
    const layout = await Bun.file(path.join(root, "app/routes/directory-layout.tsx")).text()

    expect(await Bun.file(path.join(root, "context/directory-sync.ts")).exists()).toBe(false)
    expect(helper).toMatch(/upsertDirectorySession\(directory: string, session: Session\)/)
    expect(helper).toMatch(/queryClient\.setQueryData<DirectorySessionCacheValue>/)
    expect(layout).toMatch(/resolveLegacyRedirect/)
    expect(layout).toMatch(/resolveSessionUrl/)
    expect(layout).not.toMatch(/directorySessionCacheQuery/)
    expect(layout).not.toMatch(/createSessionMessageCache\(\)/)
    expect(layout).not.toMatch(/\buseSync\b/)
    expect(layout).not.toMatch(/sync\.data/)
  })

  test("upstream session page gates diff and todo refreshes through shell query caches", async () => {
    const text = await Bun.file(path.join(root, "features/session/ui/session-screen.tsx")).text()
    const controller = await Bun.file(path.join(root, "features/session/store/session-controller.ts")).text()
    const cacheProjection = await Bun.file(path.join(root, "features/session/ui/session-screen-cache-projection.ts")).text()
    const paneQueries = await Bun.file(path.join(root, "features/session/store/session-pane-queries.ts")).text()

    expect(text).toMatch(/createSessionScreenCacheProjection\(\{ active: paneActive, directory: dir \}\)/)
    expect(cacheProjection).toMatch(/directorySessionCacheQueryOptions\(\{ directory: input\.directory\(\) \}\)/)
    expect(text).toMatch(/createActiveConversationSnapshot\(\{ directory: dir, sessionID, active: paneActive \}\)/)
    expect(text).toMatch(/SessionConversationOwner/)
    expect(text).toMatch(/sessionController\.status/)
    expect(text).toMatch(/const diffs = sessionController\.diffs/)
    expect(controller).toMatch(/createSessionPaneQueries\(\{/)
    expect(paneQueries).toMatch(/shellDataKeys\.sessionId\(sessionID, "todo"\)/)
    expect(paneQueries).toMatch(/shellDataKeys\.sessionId\(sessionID, "diff"\)/)
    expect(paneQueries).toMatch(/queryFn: skipToken/)
    expect(paneQueries).not.toMatch(/\buseSync\b/)
    expect(paneQueries).not.toMatch(/sync\.data/)
    expect(cacheProjection).not.toMatch(/\buseSync\b/)
    expect(cacheProjection).not.toMatch(/sync\.data/)
    expect(controller).toMatch(/shellDataKeys\.sessionId\(sessionID, "todo"\)/)
    expect(controller).toMatch(/sessionProjectionWorkspaceBacking\(\{[^\n]*hostKind: input\.hostKind\?\.\(\)/)
    expect(controller).toMatch(/directorySessionCacheActions\.refresh\(\{[\s\S]{0,100}\.{3}\(workspace \? \{ workspace \} : \{\}\)/)
    expect(text).not.toMatch(/sync\.data\.todo\[id\]/)
    expect(text).not.toMatch(/globalSync\.data\.session_todo\[id\]/)
    expect(text).not.toMatch(/sync\.data\.session_diff\[id\]/)
    expect(text).not.toMatch(/list\(sync\.data\.session_diff/)
    expect(text).not.toMatch(/sync\.data\.message/)
    expect(text).not.toMatch(/sync\.data\.part/)
    expect(text).not.toMatch(/sync\.data\.session_status/)
    expect(text).not.toMatch(/sync\.session\.get/)
    expect(text).not.toMatch(/sync\.set\("session"/)
    expect(text).not.toMatch(/sync\.project/)
    expect(text).not.toMatch(/sync\.set\("project"/)
    expect(text).not.toMatch(/\buseSync\b/)
  })

  test("upstream PromptInput checks review membership from shell diff queries", async () => {
    const text = await Bun.file(path.join(root, "features/session/composer/composer.tsx")).text()
    const submit = await Bun.file(path.join(root, "features/session/composer/ui/submit.ts")).text()
    const submitUiState = await Bun.file(
      path.join(root, "features/session/composer/ui/submit-ui-state.ts"),
    ).text()
    const globalSync = await Bun.file(path.join(root, globalSyncContext)).text()
    const shellQuery = await Bun.file(path.join(root, "features/session/data/query/shell.ts")).text()
    const workspaceResolver = await Bun.file(path.join(root, "features/session/composer/workspace-resolver.ts")).text()

    expect(text).not.toMatch(/agentListQuery\(/)
    expect(text).toMatch(/agents: local\.agent\.list/)
    expect(text).toMatch(/commandListQuery\(/)
    expect(text).toMatch(/enabled: hydrateDirectoryCommands\(\)/)
    expect(text).toMatch(
      /directorySessionCacheQueryOptions\(\{[\s\S]*directory: resolvedSessionDirectory\(\) \?\? sdk\.directory/,
    )
    expect(text).toMatch(/directorySessionCacheQuery\.data\?\.session\.find\(\(session\) => session\.id === sid\)/)
    expect(text).toMatch(/const projectCatalog = \(\) => \(projectsQuery\.data \?\? \[\]\) as ProjectCatalogItem\[\]/)
    expect(text).toMatch(/resolveSubmitSessionDirectory\(\{/)
    expect(workspaceResolver).toMatch(/project\.sandboxes\?\.some/)
    expect(text).toMatch(/<PromptInputFrame[\s\S]*agentNames=\{toolbarState\.agentNames\}/)
    expect(text).toMatch(/registeredConversationHasUserMessage\(sdk\.directory, sessionID\)/)
    expect(text).not.toMatch(/\buseSync\b/)
    expect(text).not.toMatch(/sync\.session\.get/)
    expect(text).not.toMatch(/sync\.data\.command/)
    expect(text).not.toMatch(/sync\.project/)
    expect(text).not.toMatch(/sync\.data\.session_diff\[sessionID\]/)
    expect(text).not.toMatch(/sync\.data\.agent/)
    expect(text).not.toMatch(/sync\.data\.message\[sessionID\]/)
    expect(submit).not.toMatch(/commandListQuery\(/)
    expect(shellQuery).toMatch(/export function commandListQuery/)
    expect(submitUiState).toMatch(/addRegisteredConversationMessage\(item\)/)
    expect(submitUiState).toMatch(/removeRegisteredConversationMessage\(item\)/)
    expect(submit).toMatch(/setPromptSessionStatus/)
    expect(submit).not.toMatch(/sessionStatusKey/)
    expect(submit).not.toMatch(/setQueryData\(sessionStatusKey/)
    expect(submit).not.toMatch(/\buseSync\b/)
    expect(submit).not.toMatch(/sync\.session\.optimistic/)
    expect(submit).not.toMatch(/sync\.data\.command/)
    expect(submit).not.toMatch(/sync\.set\("session_status"/)
    expect(globalSync).not.toMatch(/loadCommandsQuery/)
    expect(globalSync).not.toMatch(/loadAgentsQuery/)
    expect(globalSync).not.toMatch(/loadSessionsQuery/)
  })

  test("upstream DialogFork reads conversation data from registered chat projection", async () => {
    const text = await Bun.file(path.join(root, "features/session/ui/dialogs/fork.tsx")).text()

    expect(text).toMatch(/registeredConversationSnapshot\(sdk\.directory, sessionId\(\)\)/)
    expect(text).toMatch(/forkableMessages\(conversation\(\)/)
    expect(text).toMatch(/conversation\(\)\.parts\[item\.id\]/)
    expect(text).not.toMatch(/\buseSync\b/)
    expect(text).not.toMatch(/sync\.data\.message/)
    expect(text).not.toMatch(/sync\.data\.part/)
  })

  test("upstream SessionContextTab reads conversation data from registered chat projection", async () => {
    const text = await Bun.file(path.join(root, "features/session/ui/components/session-context-tab.tsx")).text()

    expect(text).toMatch(/createActiveConversationSnapshot/)
    expect(text).toMatch(/directorySessionCacheQuery\.data\?\.session\.find\(\(session\) => session\.id === id\)/)
    expect(text).toMatch(/conversation\(\)\?\.messages\.filter\(isRuntimeAgentMessage\) \?\? emptyMessages/)
    expect(text).toMatch(/parts: snapshot\.parts/)
    expect(text).toMatch(/conversation\(\)\?\.parts\[id\]/)
    expect(text).not.toMatch(/\buseSync\b/)
    expect(text).not.toMatch(/sync\.session\.get/)
    expect(text).not.toMatch(/sync\.data\.message/)
    expect(text).not.toMatch(/sync\.data\.part/)
  })

  test("upstream session commands read conversation data from registered chat projection", async () => {
    const text = await Bun.file(path.join(root, "features/session/ui/use-session-commands.tsx")).text()

    expect(text).toMatch(
      /createActiveConversationSnapshot\(\{ directory: args\.directory, sessionID: args\.sessionId, active: args\.active \}\)/,
    )
    expect(text).toMatch(/\.filter\(\(message\): message is UserMessage => message\.role === "user"\)/)
    expect(text).toMatch(/\.toSorted\(\(left, right\) => left\.id\.localeCompare\(right\.id\)\)/)
    expect(text).toMatch(/conversation\(\)\?\.parts\[message\.id\]/)
    expect(text).toMatch(/directorySessionCacheQueryOptions\(\{ directory: args\.directory\(\) \}\)\.queryKey/)
    // Claxedo ships no session-share command, the only reason this hook would
    // read config, so it reads none; never reaching for sync.data.config is
    // asserted below.
    expect(text).not.toMatch(/\buseSync\b/)
    expect(text).not.toMatch(/sync\.session\.get/)
    expect(text).not.toMatch(/sync\.data\.message/)
    expect(text).not.toMatch(/sync\.data\.part/)
    expect(text).not.toMatch(/sync\.data\.config/)
  })

  test("upstream message timeline reads messages and parts from registered chat projection", async () => {
    const text = await upstreamAppText("features/session/ui/message-timeline.tsx")

    expect(text).not.toMatch(/agentListQuery/)
    expect(text).toMatch(/read: \(\) => data\.store\.agent \?\? \[\]/)
    expect(text).toMatch(
      /const directorySessionRows = createActivePaneProjection\(\{ active: props\.active, read: props\.directorySessions/,
    )
    expect(text).toMatch(/read: \(\) => props\.status\(\) \?\? idle/)
    expect(text).toMatch(/const directorySession = \(sessionID: string \| undefined\)/)
    expect(text).toMatch(/const sessionConversation = createActiveConversationSnapshot\(\{[\s\S]{0,80}sessionID,/)
    expect(text).toMatch(/const parentConversation = createActiveConversationSnapshot\(\{[\s\S]{0,80}sessionID: parentID,/)
    expect(text).toMatch(/sessionConversation\(\)\?\.messages \?\? emptyMessages/)
    expect(text).toMatch(/parentConversation\(\)\?\.messages \?\? emptyMessages/)
    expect(text).toMatch(/sessionConversation\(\)\?\.parts\[msgId\] \?\? emptyParts/)
    expect(text).toMatch(/parentConversation\(\)\?\.parts\[msgId\] \?\? emptyParts/)
    expect(text).toMatch(/messageAgentColor\(sessionMessages\(\), directoryAgents\(\)\)/)
    expect(text).toMatch(/sessionSync\?\.syncSession\?\.\(id\)/)
    // Claxedo ships no session-share menu, the only reason for a config read, so
    // the timeline reads no directory config; `not.toMatch(/sync\.data\.config/)`
    // below pins it.
    expect(text).toMatch(/updateDirectorySession\(sdk\.directory, input\.id/)
    expect(text).toMatch(/removeDirectorySessionTree\(sdk\.directory, sessionID\)/)
    expect(text).not.toMatch(/\buseSync\b/)
    expect(text).not.toMatch(/sync\.session\.get/)
    expect(text).not.toMatch(/sync\.session\.sync/)
    expect(text).not.toMatch(/sync\.set/)
    expect(text).not.toMatch(/sync\.data\.session\b/)
    expect(text).not.toMatch(/sync\.data\.session_status/)
    expect(text).not.toMatch(/sync\.data\.agent/)
    expect(text).not.toMatch(/sync\.data\.config/)
    expect(text).not.toMatch(/sync\.data\.message/)
    expect(text).not.toMatch(/sync\.data\.part/)
    expect(text).not.toMatch(/\bproduce\(/)
  })

  test("production code has deleted the legacy conversation mirror owner bridge", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      const text = await Bun.file(path.join(root, file)).text()
      if (
        /LegacySessionConversationOwner|LegacyConversationMirrorSource|legacy-session-conversation-owner/.test(text)
      ) {
        offenders.push(file)
      }
    }

    expect(await Bun.file(path.join(root, "shell/chat/legacy-session-conversation-owner.tsx")).exists()).toBe(false)
    expect(offenders).toEqual([])
  })
})
