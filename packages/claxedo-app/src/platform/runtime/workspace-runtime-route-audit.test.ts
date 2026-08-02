// PENDING REWRITE (chip task_ac7919fb): this string-grep route/boundary audit
// is slated to be replaced by declarative scanner rules (architecture/scanners).
// Until then it is kept honest by mechanical reconciliation to production drift.
// Known dead-invariant assertions that survive that rewrite, NOT masked here
// because WP-D2 collapsed the two-alias world (@claxedo/ first-party vs @/
// upstream/override) into a single @/ alias, which erased the distinction these
// assertions encoded:
//   - "Claxedo command context owns the typed command bus bridge": the
//     `@/app/providers/command` offender scan now flags legitimate first-party imports.
//   - "Claxedo platform context owns desktop and auth platform capabilities":
//     same, for `@/platform/runtime/platform-provider`.
//   - "Claxedo language context owns extension string merging": same, for
//     `@/platform/i18n/provider`.
//   - "directory-layout route is a pass-through": the `@claxedo/pages/...`
//     positive + `@/pages/...` negative pair is un-expressible post-collapse
//     (app/entry/app.tsx now legitimately imports `@/app/routes/directory-layout`).
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { can, RolePolicy } from "@/platform/auth/role"
import type { Placement, RelayRole } from "@/platform/runtime/placement"
import { sameSessionIdentity } from "@/platform/sync/global-session-identity"

const root = path.resolve(import.meta.dir, "../..")
const upstreamAppRoot = path.resolve(root, "../../app/src")
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
  "platform/api/credential-request.ts",
  "app/connection/server-health.ts",
  "features/workspaces/data/share-workspace.ts",
  "platform/runtime/agent/workspace-control-routes.ts",
  // The sandbox-driver path literals `workspace-control-routes.ts` builds its
  // URLs from, split into an import-free module so claxedo-server's
  // `sandbox-driver-routes.contract.test.ts` can dispatch them through the real
  // Hono router. Same route-boundary role, now bindable from the server side.
  "platform/runtime/agent/workspace-control-paths.ts",
  "platform/runtime/agent/dialog-select-directory-routes.ts",
  "app/workbench/state/route-bridge.tsx",
  // Pure route→session resolution + session-probe URL builders split out of
  // route-bridge.tsx (Wave 2); the same route-boundary role, now unit-testable.
  "app/workbench/state/route-bridge-resolution.ts",
  "features/session/data/sync/inventory-source.ts",
  "platform/runtime/transport.ts",
  "app/boot/data/bootstrap.ts",
  "features/session/composer/ui/submit-transport.ts",
  "features/session/harness/harness-config-runtime.ts",
  // Cross-feature provider query adapter owns the explicit harness-scoped
  // provider route used by settings and session model selectors.
  "platform/query/control-plane.ts",
])

const workspaceRuntimeIdentityBoundary = new Set([
  ...runtimeGatewayBoundary,
  "platform/identity/legacy-resolver.ts",
  "platform/runtime/agent/agent-runtime-client.ts",
  // Pure session-routing decision table split out of agent-runtime-client.ts
  // (Wave 2 resolver collapse); the same runtime-identity boundary role, now
  // unit-testable — re-exports the canonical workspaceIdFromRef selector.
  "platform/runtime/agent/placement-table.ts",
  "platform/runtime/session-workspace.ts",
])

const workspaceSelectorSyntaxBoundary = new Set([
  ...workspaceRuntimeIdentityBoundary,
  "architecture/scanners.ts",
  "platform/sync/worktree.ts",
  // WP-A2 collapsed the wrapper aliases into the canonical workspaceIdFromRef
  // export, imported directly here now instead of through a retired wrapper.
  "platform/runtime/placement.ts",
  "app/providers/global-sdk-event-fetch.ts",
  "features/workspaces/ui/panel/workspace-panel.tsx",
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
  "app/workbench/titlebar/titlebar.tsx",
  "platform/comments/provider.tsx",
  "features/session/providers/permission.tsx",
])

// Files vendored verbatim from upstream packages/app (divorce plan 006) that
// import the @/app/providers/command and @/platform/runtime/platform-provider owner aliases. Post-
// divorce those aliases resolve to the same claxedo-owned context modules, so
// these imports are correct; new claxedo code should still use relative paths.
const vendoredCommandAliasBoundary = new Set([
  "app/workbench/titlebar/titlebar.tsx",
  "features/settings/ui/keybinds.tsx",
  "app/entry/windows-app-menu.tsx",
])

const vendoredPlatformAliasBoundary = new Set([
  "app/controls/link.tsx",
  "app/workbench/titlebar/titlebar.tsx",
  "app/entry/windows-app-menu.tsx",
  "app/dialogs/select-server.tsx",
  "features/review/providers/highlights.tsx",
])

const sessionRenderBoundary = new Set(["features/session/ui/content/session-content.tsx"])

const sessionRefHostOwnerBoundary = new Set(["platform/identity/session-ref.ts"])

const commandContext = "app/providers/command.tsx"
const platformContext = "platform/runtime/platform-provider.tsx"
const sessionContextTab = "features/session/ui/components/session-context-tab.tsx"
const sessionNewView = "features/session/ui/components/session-new-view.tsx"
const agentHarnessSelector = "features/session/ui/controls/agent-harness-selector.tsx"
const sessionCommandsHook = "features/session/ui/use-session-commands.tsx"
const syncContext = "overrides/context/sync.tsx"
const sdkContext = "app/providers/sdk/sdk.tsx"
const languageContext = "platform/i18n/provider.tsx"
const homePage = "app/routes/home.tsx"
const pageIndex = "features/documents/editor/document-index.tsx"
const reviewWorkspace = "app/workbench/review/review-workspace.tsx"
const sessionPage = "features/session/ui/session-screen.tsx"
const sessionTimeline = "features/session/ui/message-timeline.tsx"
const sessionController = "features/session/store/session-controller.ts"
const sessionStatusTelemetry = "features/session/store/session-status-telemetry.ts"
const agentStatusListener = "app/workbench/state/agent-status-listener.ts"
const sessionComposer = "features/session/ui/composer/index.ts"
const sessionComposerRegion = "features/session/ui/composer/session-composer-region.tsx"
const sessionComposerState = "features/session/ui/composer/session-composer-state.ts"
const upstreamSessionComposerRegion = "features/session/ui/composer/session-composer-region.tsx"
const globalSyncContext = "app/providers/global-sync/provider.tsx"
const sessionRefIdentity = "platform/identity/session-ref.ts"
const directoryEventProjector = "features/session/data/sync/directory-event-projector.ts"
const globalEventProjector = "platform/sync/global-event-projector.ts"
const sessionCache = "features/session/data/sync/session-cache-cleanup.ts"
const sessionListEvents = "features/session/data/sync/session-list-events.ts"
const directoryScope = "app/workbench/context/directory-scope.tsx"
const dialogSelectDirectory = "app/dialogs/select-directory.tsx"
const dialogSelectFile = "features/session/ui/dialogs/select-file.tsx"
const sessionNewDesignView = "features/session/ui/components/session-new-design-view.tsx"
const sessionHeader = "features/session/ui/components/session-header.tsx"
const promptInput = "features/session/composer/composer.tsx"
const promptSubmit = "features/session/composer/ui/submit.ts"
const promptSubmitPending = "features/session/submit/pending.ts"
const promptSubmitSend = "features/session/submit/send.ts"
const promptSubmitTypes = "features/session/submit/types.ts"
const promptContext = "features/session/providers/prompt.tsx"
const terminalComponent = "features/terminal/ui/terminal.tsx"
const terminalContext = "features/terminal/providers/provider.tsx"
// WP-B6 extracted the prompt/terminal cache internals (disposable-resource
// struct, LRU eviction, ref-count dispose-once) into this shared module. The
// audit assertions that used to inline-match those structures in
// prompt.tsx/terminal.tsx now verify the same invariants against this file.
const liveResourceCache = "platform/sync/live-resource-cache.ts"
const roleGuardedTerminal = "features/terminal/core/role-guarded-terminal.tsx"
const reviewTab = "features/review/ui/review-tab.tsx"
const harnessConfigStore = "features/session/harness/harness-config-store.ts"
const harnessConfigRuntime = "features/session/harness/harness-config-runtime.ts"
const harnessStorePolicy = "features/session/harness/store-policy.ts"
const appShellLayout = "app/app-shell-layout.tsx"
const railSidebarShell = "app/workbench/rail/rail-sidebar-shell.tsx"
const railWorkbenchShell = "app/workbench/rail/rail-workbench-shell.tsx"
const railSidebar = "app/workbench/rail/rail-sidebar.tsx"
const layoutContext = "app/providers/layout.tsx"
const dialogEditProject = "features/workspaces/ui/dialog-edit-project.tsx"
const appShell = "app/app-shell.tsx"
const appShellState = "app/app-shell-state.ts"
const appShellRouteSync = "app/app-shell-route-sync.ts"
const claxedoSessionActions = "features/session/actions/session-actions.tsx"
const claxedoProjectActions = "features/workspaces/actions/project-actions.tsx"
const claxedoWorkspaceActions = "features/workspaces/actions/workspace-actions.ts"
const claxedoWorkspaceRecovery = "features/workspaces/actions/workspace-recovery.tsx"
const claxedoActionShared = "app/workbench/actions/shared.ts"
const directorySessionCache = "features/session/data/sync/directory-session-cache.ts"
const notificationContext = "app/providers/notification.tsx"
const providerHook = "app/providers/use-providers.ts"
// The Local selection provider (useLocal/LocalProvider) was colocated into
// features/session/providers/session-selection.tsx during Wave 2; context/local.tsx is deleted.
const localContextOwner = "features/session/providers/session-selection.tsx"
const dialogSettings = "app/dialogs/settings.tsx"
const settingsGeneral = "features/settings/ui/general.tsx"
const settingsProviders = "features/settings/ui/providers.tsx"
const settingsSandboxSection = "features/settings/ui/sandbox-section.tsx"
const networkPolicySettings = "features/settings/ui/network-policy.tsx"
// The connect flow and the provider catalog were extracted so the onboarding
// setup page renders the same surfaces the dialogs do. The dialogs are now
// shells; these invariants belong to the files that hold the logic.
const dialogConnectProvider = "app/dialogs/provider-connect-form.tsx"
const dialogCustomProvider = "app/dialogs/custom-provider.tsx"
const dialogSelectProvider = "app/dialogs/provider-list.tsx"
const dialogManageModels = "app/dialogs/manage-models.tsx"
const dialogSelectModel = "features/session/ui/model/select-model.tsx"
const promptModelStrategy = "features/session/composer/model-strategy.ts"
const promptToolbarState = "features/session/composer/toolbar-state.ts"
const routeIntent = "app/workbench/state/route-intent.ts"
const contentRenderers = [
  "app/workbench/content/context-content.tsx",
  "features/documents/ui/content/page-content.tsx",
  "features/session/ui/content/session-content.tsx",
  "features/terminal/ui/content/terminal-content.tsx",
]
const projectInventoryContentRenderers = ["features/documents/ui/content/pages-index-content.tsx"]
const sessionPaneScope = "features/session/ui/components/session-pane-scope.tsx"
const openSessionsRegistry = "features/session/store/open-sessions.ts"
const panePreferences = "features/session/preferences/pane.ts"

async function files(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await Array.fromAsync(new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: dir }))) {
    if (entry.endsWith(".d.ts")) continue
    // Demo-only msw fixtures moved from src/demo/ to src/app/demo/ in the
    // app/features/platform reorg; they legitimately spell route strings.
    if (
      entry.includes(".test.") ||
      entry.includes(".vitest.") ||
      entry.startsWith("demo/") ||
      entry.startsWith("app/demo/")
    )
      continue
    out.push(entry)
  }
  return out
}

// Route-literal scans must read code, not prose. Comments legitimately name
// endpoints they document the removal of (e.g. the retired `/documents/events`
// SSE), and a bare text scan reports those as boundary violations.
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
}

async function upstreamAppText(file: string) {
  const upstream = Bun.file(path.join(upstreamAppRoot, file))
  if (await upstream.exists()) return await upstream.text()
  return await Bun.file(path.join(root, file)).text()
}

async function upstreamAppFileExists(file: string) {
  return await Bun.file(path.join(upstreamAppRoot, file)).exists()
}

describe("workspace runtime route audit", () => {
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
        const unsafe = match[1]!
          .split(",")
          .map((item) => item.trim().replace(/\s+as\s+\w+$/, ""))
          .filter(
            (item) =>
              item !== "isUserHostedWorkspaceDirectory" &&
              (item !== "workspaceIdFromDirectoryRef" || !workspaceRuntimeIdentityBoundary.has(file)),
          )
        if (unsafe.length > 0)
          offenders.push(`${file}: imports/exports ${unsafe.join(", ")} from workspace-runtime-request`)
      }
    }
    const runtimeStore = await Bun.file(path.join(root, "platform/runtime/cloud/workspace-runtime-store.ts")).text()
    const agentRuntimeClient = await Bun.file(path.join(root, "platform/runtime/agent/agent-runtime-client.ts")).text()
    const httpBackend = await Bun.file(path.join(root, "platform/runtime/http-backend.ts")).text()
    const globalSync = await Bun.file(path.join(root, globalSyncContext)).text()
    const globalSyncBootstrap = await Bun.file(path.join(root, "app/boot/data/bootstrap.ts")).text()
    expect(runtimeStore).toMatch(/sessionWorkspaceRuntimeRef/)
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
      if (
        file !== "platform/runtime/agent/workspace-relay-connection.ts" &&
        /\bfunction\s+runtimeKind\s*\(/.test(text)
      ) {
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
    // WP-A2 collapsed the wrapper aliases (workspaceIdFromDirectoryRef /
    // workspaceIdFromLegacyScope) into the one canonical workspaceIdFromRef
    // export (LLD appendix rename table) — worktree.ts and
    // workspace-runtime-request.ts now import that canonical name directly
    // instead of going through a retired wrapper.
    expect(await Bun.file(path.join(root, "platform/sync/worktree.ts")).text()).toMatch(/workspaceIdFromRef/)
    expect(request).toMatch(/workspaceIdFromRef/)
    expect(legacyResolver).toMatch(/workspaceIdFromRef/)
    expect(offenders).toEqual([])
  })

  test("raw legacy string-shape predicate names stay inside the resolver owner", async () => {
    // WP-A2 deleted the wrapper aliases and made these raw predicate names
    // THE canonical exports of legacy-resolver.ts, now imported at ~19 call
    // sites — importing (and calling) the canonical predicate from its
    // resolver owner is exactly the sanctioned pattern. This rule instead
    // guards against a file REIMPLEMENTING the string-shape parsing locally
    // (a local function/const/let/var re-declaration of one of these names),
    // or acquiring the name from anywhere other than the resolver owner.
    const rawNames = [
      "isFilesystemDirectory",
      "isUserHostedWorkspaceDirectory",
      "workspaceIdFromDirectoryRef",
      "isWorkspaceIdRef",
      "workspaceIdFromRef",
    ]
    const rawNamePattern = new RegExp(`\\b(?:${rawNames.join("|")})\\b`, "g")
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (file === "platform/identity/legacy-resolver.ts") continue
      if (file.startsWith("architecture/")) continue
      const text = await Bun.file(path.join(root, file)).text()
      const usedNames = new Set(text.match(rawNamePattern) ?? [])
      if (usedNames.size === 0) continue

      const importedFromResolver = new Set<string>()
      for (const match of text.matchAll(
        /(?:import|export)\s*(?:type\s*)?\{([^}]+)\}\s*from\s*["'][^"']*legacy-resolver["']/g,
      )) {
        for (const spec of match[1]!.split(",")) {
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
    const custom = await Bun.file(path.join(root, dialogCustomProvider)).text()
    const sandbox = await Bun.file(path.join(root, settingsSandboxSection)).text()

    for (const text of [connect, custom, sandbox]) {
      expect(text).not.toMatch(/\b(?:localStorage|sessionStorage)\b/)
      expect(text).not.toMatch(/\b(?:Persist\.global|persisted|setPersisted)\b/)
    }
    expect(connect).toMatch(/claxedoCredentialRequest/)
    expect(custom).toMatch(/claxedoCredentialRequest/)
    expect(sandbox).toMatch(/createSignal<Record<string, Record<string, string>>>/)
    expect(sandbox).toMatch(/workspaceSandboxDriverAuthUrl/)
    expect(sandbox).not.toMatch(/RuntimeGateway/)
  })

  test("workspace mutation UIs are gated by backend-derived role policy", async () => {
    const networkPolicy = await Bun.file(path.join(root, networkPolicySettings)).text()
    const serverPolicyTest = await Bun.file(
      path.join(root, "..", "..", "claxedo-server/src/control-plane/convex-agent-extensions-policy.test.ts"),
    ).text()
    const serverRouteTest = await Bun.file(
      path.join(root, "..", "..", "claxedo-server/src/routes/agent-config-extensions.test.ts"),
    ).text()
    const serverNetworkPolicyTest = await Bun.file(
      path.join(root, "..", "..", "claxedo-server/src/routes/network-policy.test.ts"),
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
    expect([...RolePolicy.admin].sort()).toEqual([...RolePolicy.owner].sort())
    expect(can("mutate.session", placement("editor"))).toBe(true)
    expect(can("mutate.workspace", placement("editor"))).toBe(false)
    expect(can("manage.runners", placement("editor"))).toBe(false)
    expect(can("read.workspace", placement("viewer"))).toBe(true)
    expect(can("use.terminal", placement("viewer"))).toBe(false)
    expect(serverPolicyTest).toMatch(/denies %s workspace members admin Agent Extension mutations/)
    expect(serverPolicyTest).toMatch(/allows admin workspace members to manage Agent Extension installs/)
    expect(serverRouteTest).toMatch(/authorizeWorkspaceAgentExtensionsAdmin/)
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
      const text = await Bun.file(path.join(root, file)).text()
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
      const text = await Bun.file(path.join(root, file)).text()
      if (/["'`]\/api\/claxedo\/events(?:[?"'`])/.test(text)) {
        offenders.push(file)
      }
    }
    const events = await Bun.file(path.join(root, "app/integrations/claxedo-events.tsx")).text()
    expect(events).toMatch(/sessionWorkspaceRuntimeRef/)
    expect(events).not.toMatch(/workspaceIdFromDirectoryRef/)
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
      if (/["'`](?:\/vcs|\/mcp|\/lsp)["'`]/.test(text)) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  test("production code builds workspace agent and provider routes only through route boundaries", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      if (runtimeGatewayBoundary.has(file)) continue
      const text = await Bun.file(path.join(root, file)).text()
      if (/["'`](?:\/agent|\/command|\/provider)(?:[?"'`])/.test(text)) {
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

  test("PageIndex derives repository import identity from explicit project props", async () => {
    const text = await Bun.file(path.join(root, pageIndex)).text()

    expect(text).toMatch(/props\.projects/)
    expect(text).toMatch(/props\.directory/)
    expect(text).toMatch(/workspaceId/)
    expect(text).not.toMatch(/useGlobalSync/)
    expect(text).not.toMatch(/project\.ensure/)

    // Repository import moved out of the documents index and into the review
    // workspace; `document-index.vitest.tsx` now asserts the index never calls
    // it. Follow the behavior so this stays a live invariant rather than a
    // symbol that silently no longer exists anywhere it is asserted.
    const repositoryImport = await Bun.file(path.join(root, reviewWorkspace)).text()
    expect(repositoryImport).toMatch(/createFromRepository/)
    expect(repositoryImport).toMatch(/props\.directory/)
    expect(repositoryImport).toMatch(/workspaceId/)
    expect(repositoryImport).not.toMatch(/useGlobalSync/)
  })

  test("production consumers do not call global-sync project inventory actions", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      const text = await Bun.file(path.join(root, file)).text()
      if (/\b(?:globalSync|props\.globalSync|sync)\.project\.(?:ensure|reload)\(/.test(text)) offenders.push(file)
    }

    expect(offenders).toEqual([])
  })

  test("DialogSelectDirectory reads path inventory through query options", async () => {
    const text = await Bun.file(path.join(root, dialogSelectDirectory)).text()
    const cache = await upstreamAppText("platform/query/directory-search-cache.ts")

    expect(text).toMatch(/useQueryOptions/)
    expect(text).toMatch(/queryOptions\.path\(null\)/)
    expect(text).toMatch(/cachedDirectoryChildrenRequest/)
    expect(cache).toMatch(/"directory-children-request"/)
    expect(text).not.toMatch(/const cache = new Map/)
    expect(text).not.toMatch(/cache\.(?:get|set)/)
    expect(text).not.toMatch(/useGlobalSync/)
    expect(text).not.toMatch(/sync\.data\.path/)
  })

  test("NewSessionDesignView reads cross-project inventory through query options", async () => {
    const text = await Bun.file(path.join(root, sessionNewDesignView)).text()

    expect(text).toMatch(/useQueryOptions/)
    expect(text).toMatch(/queryOptions\.projects\(\)/)
    expect(text).not.toMatch(/useGlobalSync/)
    expect(text).not.toMatch(/\buseSync\b/)
    expect(text).not.toMatch(/globalSync\.data\.project/)
  })

  test("NewSessionView reads workspace choices through query options", async () => {
    const text = await Bun.file(path.join(root, sessionNewView)).text()
    const rootHelper = await Bun.file(path.join(root, "features/session/ui/components/session-new-view-root.ts")).text()
    const workspaceOptions = await Bun.file(
      path.join(root, "features/session/ui/components/session-new-workspace-options.ts"),
    ).text()

    expect(text).toMatch(/useQueryOptions/)
    expect(text).toMatch(/queryOptions\.projects\(\)/)
    expect(text).toMatch(/directorySessionCacheQueryOptions/)
    expect(text).not.toMatch(/useGlobalSync/)
    expect(text).not.toMatch(/\buseSync\b/)
    expect(text).not.toMatch(/globalSync\.sessionInventory\.store/)
    expect(rootHelper).toMatch(/sessionWorkspaceRuntimeRef/)
    expect(rootHelper).not.toMatch(/workspaceIdFromDirectoryRef/)
    expect(workspaceOptions).toMatch(/sessionWorkspaceRuntimeRef/)
    expect(workspaceOptions).not.toMatch(/workspaceIdFromDirectoryRef/)
  })

  test("SDKProvider resolves signed workspaces through query options", async () => {
    const text = await Bun.file(path.join(root, sdkContext)).text()

    expect(text).toMatch(/useQueryOptions/)
    expect(text).toMatch(/queryOptions\.projects\(\)/)
    expect(text).not.toMatch(/useGlobalSync/)
    expect(text).not.toMatch(/globalSync\.data\.project/)
  })

  test("harness config store resolves workspace inventory through query options", async () => {
    const text = `${await Bun.file(path.join(root, harnessConfigStore)).text()}\n${await Bun.file(path.join(root, harnessConfigRuntime)).text()}`

    expect(text).toMatch(/useQueryOptions/)
    expect(text).toMatch(/queryOptions\.projects\(\)/)
    expect(text).toMatch(/useDirectorySessionCacheActions/)
    expect(text).toMatch(/directorySessionCacheActions\.refresh/)
    expect(text).toMatch(/harnessWorkspaceRuntimeRef/)
    expect(text).not.toMatch(/workspaceIdFromDirectoryRef/)
    expect(text).not.toMatch(/globalSync\.data\.project/)
    expect(text).not.toMatch(/globalSync\.child/)
  })

  test("LayoutProvider reads project inventory through query options", async () => {
    const text = await Bun.file(path.join(root, layoutContext)).text()

    expect(text).toMatch(/useQueryOptions/)
    expect(text).toMatch(/queryOptions\.projects\(\)/)
    expect(text).toMatch(/queryKeys\.directory\.projectMeta/)
    expect(text).toMatch(/queryKeys\.directory\.icon/)
    expect(text).toMatch(/setProjectIcon/)
    expect(text).toMatch(/upsertProjectMeta/)
    expect(text).toMatch(/useDirectorySessionCacheActions/)
    expect(text).toMatch(/directorySessionCacheActions\.ensure/)
    expect(text).toMatch(/sessionWorkspaceRuntimeRef/)
    expect(text).not.toMatch(/workspaceIdFromDirectoryRef/)
    expect(text).not.toMatch(/globalSync\.data\.project/)
    expect(text).not.toMatch(/globalSync\.project\.(?:meta|icon)/)
    expect(text).not.toMatch(/globalSync\.project\.loadSessions/)
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
    expect(text).toMatch(/directorySessionCacheActions\.ensure/)
    expect(text).toMatch(/sessionInventoryQueryOptions/)
    expect(text).not.toMatch(/globalSync\.data\.project/)
    expect(text).not.toMatch(/globalSync\.sessionInventory\.store/)
    expect(text).not.toMatch(/globalSync\.data\.path\.home/)
    expect(text).not.toMatch(/globalSync\.child/)
  })

  test("provider settings read provider and config inventory through query options", async () => {
    const hook = await Bun.file(path.join(root, providerHook)).text()
    const settingsDialog = await Bun.file(path.join(root, dialogSettings)).text()
    const general = await Bun.file(path.join(root, settingsGeneral)).text()
    const settings = await Bun.file(path.join(root, settingsProviders)).text()
    const connect = await Bun.file(path.join(root, dialogConnectProvider)).text()
    const custom = await Bun.file(path.join(root, dialogCustomProvider)).text()
    const select = await Bun.file(path.join(root, dialogSelectProvider)).text()
    const manageModels = await Bun.file(path.join(root, dialogManageModels)).text()
    const selectModel = await Bun.file(path.join(root, dialogSelectModel)).text()
    const prompt = await Bun.file(path.join(root, promptInput)).text()
    const commands = await Bun.file(path.join(root, sessionCommandsHook)).text()
    const providerConsumers = await Promise.all(
      [
        settingsProviders,
        dialogConnectProvider,
        dialogCustomProvider,
        dialogSelectProvider,
        dialogManageModels,
        dialogSelectModel,
        sessionContextTab,
        promptInput,
        localContextOwner,
      ].map((file) => Bun.file(path.join(root, file)).text()),
    )

    expect(await Bun.file(path.join(root, "overrides/hooks/use-providers.ts")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "overrides/components/dialog-settings.tsx")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "overrides/components/settings-general.tsx")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "overrides/components/settings-providers.tsx")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, providerHook)).exists()).toBe(true)
    expect(await Bun.file(path.join(root, dialogSettings)).exists()).toBe(true)
    expect(await Bun.file(path.join(root, settingsGeneral)).exists()).toBe(true)
    expect(await Bun.file(path.join(root, settingsProviders)).exists()).toBe(true)
    expect(hook).toMatch(/useQueryOptions/)
    expect(hook).toMatch(/queryOptions\.providers\(dir\(\) \|\| null, harness\(\)\)/)
    expect(hook).toMatch(/useShellQueryOptions as useQueryOptions/)
    expect(hook).not.toMatch(/useGlobalSync/)
    expect(hook).not.toMatch(/globalSync\.data\.provider/)
    // Post-reorg the canonical provider-inventory hook lives at
    // app/providers/use-providers; feature-owned consumers acquire it (and the
    // provider dialogs) through their feature app-ports module, whose types are
    // pinned to the canonical owners below — same single-owner invariant.
    const settingsPorts = await Bun.file(path.join(root, "features/settings/app-ports.ts")).text()
    const sessionPorts = await Bun.file(path.join(root, "features/session/app-ports.ts")).text()
    expect(settingsPorts).toMatch(/import type \* as Providers from "@\/app\/providers\/use-providers"/)
    expect(sessionPorts).toMatch(/import type \* as Providers from "@\/app\/providers\/use-providers"/)
    for (const text of providerConsumers) {
      expect(text).toMatch(/@\/app\/providers\/use-providers|@\/features\/(?:settings|session)\/app-ports/)
      expect(text).not.toMatch(/@\/context\/use-providers/)
      expect(text).not.toMatch(/@\/hooks\/use-providers|@claxedo\/hooks\/use-providers/)
      expect(text).not.toMatch(/["']\/hooks\/use-providers["']/)
    }
    expect(settings).toMatch(/queryOptions\.globalConfig\(\)/)
    expect(settings).toMatch(/queryOptions\.providers\(null\)/)
    expect(settings).toMatch(/globalSDK\.client\.global\.config[\s\S]{0,80}\.update/)
    expect(settings).toMatch(
      /isConfigCustom\(providerID\)[\s\S]{0,120}claxedoCredentialRequest\(\{ providerId: providerID \}/,
    )
    expect(settings).not.toMatch(/useGlobalSync/)
    expect(settings).not.toMatch(/globalSync\.updateConfig/)
    expect(settings).not.toMatch(/globalSync\.data\.(?:provider|config)/)
    expect(settings).not.toMatch(/globalSync\.set\("(?:provider|config)"/)
    expect(settingsDialog).toMatch(/@\/features\/settings\/ui\/general/)
    expect(settingsDialog).toMatch(/@\/features\/settings\/ui\/providers/)
    expect(settingsDialog).toMatch(/@\/features\/settings\/ui\/terminals/)
    expect(settingsDialog).toMatch(/@\/features\/settings\/ui\/sandbox-section/)
    // The dialog no longer reads config itself — each tab owns its own data and
    // the dialog only needs the server URL. `@/app/providers/config` is still
    // the sanctioned config provider (app.tsx, home.tsx, rail-account-menu, …);
    // it is simply not a dependency of the dialog shell any more. The negative
    // assertions below remain the live invariant.
    expect(settingsDialog).toMatch(/@\/app\/connection\/server/)
    expect(settingsDialog).not.toMatch(/@\/components\/settings\//)
    expect(settingsDialog).not.toMatch(/@\/context\/config/)
    expect(general).toMatch(/AccountSettingsSection/)
    expect(general).toMatch(/@\/features\/settings\/ui\/account-section/)
    expect(general).not.toMatch(/@\/components\/settings\/account-section/)
    expect(general).not.toMatch(/@claxedo\/context\/config/)
    expect(connect).toMatch(/queryOptions\.providerAuth\(props\.harness\)/)
    expect(connect).toMatch(/queryOptions\.providers\(null\)/)
    expect(connect).toMatch(/claxedoCredentialRequest/)
    expect(connect).not.toMatch(/globalSync\.data\.(?:provider|provider_auth)/)
    expect(connect).not.toMatch(/globalSync\.set\("provider"/)
    expect(custom).toMatch(/queryOptions\.globalConfig\(\)/)
    expect(custom).toMatch(/queryOptions\.providers\(null\)/)
    expect(custom).toMatch(/claxedoCredentialRequest/)
    expect(custom).toMatch(/globalSDK\.client\.global\.config[\s\S]{0,80}\.update/)
    expect(custom).toMatch(/@\/app\/dialogs\/select-provider/)
    expect(custom).not.toMatch(/@\/components\/dialogs\/select-provider/)
    expect(custom).not.toMatch(/\.\/dialog-select-provider/)
    expect(custom).not.toMatch(/globalSDK\.client\.auth\.set/)
    expect(custom).not.toMatch(/auth:\s*\{[\s\S]{0,120}key:/)
    expect(custom).not.toMatch(/useGlobalSync/)
    expect(custom).not.toMatch(/globalSync\.data\.(?:provider|config)/)
    expect(await Bun.file(path.join(root, "overrides/components/dialog-connect-provider.tsx")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "overrides/components/dialog-custom-provider.tsx")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "overrides/components/dialog-manage-models.tsx")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "overrides/components/dialog-select-model.tsx")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "overrides/components/dialog-select-provider.tsx")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, dialogConnectProvider)).exists()).toBe(true)
    expect(await Bun.file(path.join(root, dialogCustomProvider)).exists()).toBe(true)
    expect(await Bun.file(path.join(root, dialogManageModels)).exists()).toBe(true)
    expect(await Bun.file(path.join(root, dialogSelectModel)).exists()).toBe(true)
    expect(await Bun.file(path.join(root, dialogSelectProvider)).exists()).toBe(true)
    // The settings feature reaches the app-owned provider dialogs through its
    // app-ports module (pinned above to @/app/dialogs/*), never via relative
    // or legacy component paths.
    expect(settings).toMatch(/DialogConnectProvider/)
    expect(settings).toMatch(/DialogCustomProvider/)
    expect(settings).toMatch(/@\/features\/settings\/app-ports/)
    expect(settingsPorts).toMatch(/import type \* as ConnectProvider from "@\/app\/dialogs\/connect-provider"/)
    expect(settingsPorts).toMatch(/import type \* as CustomProvider from "@\/app\/dialogs\/custom-provider"/)
    expect(settingsPorts).toMatch(/import type \* as SelectProvider from "@\/app\/dialogs\/select-provider"/)
    expect(settings).not.toMatch(/@\/components\/dialogs\/(?:connect|custom)-provider/)
    expect(settings).not.toMatch(/\.\/dialog-connect-provider/)
    expect(settings).not.toMatch(/@\/components\/dialog-custom-provider/)
    // `select` is now the shared catalog (provider-list.tsx): it owns the
    // provider inventory read and the i18n strings, but not the routing.
    expect(select).toMatch(/@\/app\/providers\/use-providers/)
    expect(select).not.toMatch(/@\/context\/use-providers/)
    expect(select).toMatch(/@\/platform\/i18n\/provider/)
    // Selection routing stayed in the dialog shell that wraps the catalog.
    const selectShell = await Bun.file(path.join(root, "app/dialogs/select-provider.tsx")).text()
    expect(selectShell).toMatch(/@\/app\/dialogs\/connect-provider/)
    expect(selectShell).not.toMatch(/@\/components\/dialogs?\/connect-provider|@\/components\/dialog-connect-provider/)
    expect(selectShell).toMatch(/@\/app\/dialogs\/custom-provider/)
    expect(selectShell).not.toMatch(/@\/components\/dialogs?\/custom-provider|@\/components\/dialog-custom-provider/)
    expect(selectShell).not.toMatch(/\.\/dialog-connect-provider/)
    expect(selectShell).not.toMatch(/\.\/dialog-custom-provider/)
    expect(manageModels).toMatch(/@\/app\/dialogs\/select-provider/)
    expect(manageModels).not.toMatch(/@\/components\/dialogs?\/select-provider|@\/components\/dialog-select-provider/)
    // The session feature's model picker lazy-loads the app-owned dialogs
    // through session app-ports loaders, whose types are pinned to
    // @/app/dialogs/* — same canonical-owner invariant, boundary-shaped.
    expect(selectModel).toMatch(/loadSelectProviderDialog/)
    expect(selectModel).toMatch(/loadManageModelsDialog/)
    expect(selectModel).toMatch(/@\/features\/session\/app-ports/)
    expect(sessionPorts).toMatch(/import type \* as ManageModels from "@\/app\/dialogs\/manage-models"/)
    expect(sessionPorts).toMatch(/import type \* as SelectProvider from "@\/app\/dialogs\/select-provider"/)
    expect(sessionPorts).toMatch(/import type \* as ConnectProvider from "@\/app\/dialogs\/connect-provider"/)
    expect(selectModel).not.toMatch(/@\/components\/dialog-manage-models/)
    expect(selectModel).not.toMatch(/@\/components\/dialog-select-provider/)
    expect(selectModel).not.toMatch(/\.\/dialog-select-provider/)
    expect(selectModel).not.toMatch(/\.\/dialog-manage-models/)
    expect(commands).toMatch(/@\/features\/session\/ui\/model\/select-model/)
    expect(commands).not.toMatch(/@\/components\/dialogs?\/select-model|@\/components\/dialog-select-model/)
    expect(prompt).toMatch(/@\/features\/session\/ui\/model\/select-model/)
    expect(prompt).not.toMatch(/@\/components\/dialogs?\/select-model|@\/components\/dialog-select-model/)
    // The composer routes EVERY model click to the standard picker above. The
    // "unpaid model" funnel dialog that used to intercept clicks when no paid
    // provider was connected is deleted, not deprecated — it dead-ended on an
    // empty free-model list. Nothing may reintroduce it.
    expect(await Bun.file(path.join(root, "features/session/ui/model/select-model-unpaid.tsx")).exists()).toBe(false)
    expect(prompt).not.toMatch(/select-model-unpaid|DialogSelectModelUnpaid|onUnpaidModelClick/)
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
    expect(context).toMatch(/cachedGlobalSyncSdkClient/)
    expect(context).toMatch(/clearGlobalSyncSdkClientsForDirectory/)
    expect(context).toMatch(/@\/features\/session\/data\/sync\/global-sync-types/)
    expect(context).not.toMatch(/@\/shell\/data\/global-sync-types/)
    expect(context).not.toMatch(/@\/context\/global-sync\/types/)
    expect(context).not.toMatch(/sdkCache = new Map/)
    expect(context).not.toMatch(/sdkCache\.(?:get|set|delete|keys)/)
    expect(sdkClientCache).toMatch(/"global-sync-sdk-client"/)
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
      "app/integrations/sync/global-readiness.ts",
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

  test("route intent reads session inventory from the query boundary, not the global-sync mirror", async () => {
    const routeIntentText = await Bun.file(path.join(root, routeIntent)).text()
    const appShellStateText = await Bun.file(path.join(root, appShellState)).text()
    const routeBridgeText = await Bun.file(path.join(root, "app/workbench/state/route-bridge.tsx")).text()
    const sessionTitleSyncText = await Bun.file(path.join(root, "features/session/lib/session-title-sync.ts")).text()

    expect(routeIntentText).toMatch(/inventory\?: Accessor/)
    expect(routeIntentText).toMatch(/sessionRefForWorkspaceSession/)
    expect(routeIntentText).toMatch(/sessionRef: target\.sessionRef/)
    expect(routeIntentText).toMatch(
      /sessionRef: sessionRefForWorkspaceSession\(\{[\s\S]*sessionId: intent\.sessionId,[\s\S]*directory: workspaceId/,
    )
    expect(routeIntentText).not.toMatch(/globalSessions/)
    expect(routeIntentText).not.toMatch(/\.store/)
    expect(appShellStateText).toMatch(/sessionInventoryQueryOptions/)
    expect(routeBridgeText).toMatch(/inventory: \(\) => \(\{/)
    expect(routeBridgeText).toMatch(/routeSessionCacheQuery\.data\?\.session\.find\(\(s\) => s\.id === id\)/)
    expect(routeBridgeText).toMatch(/sessionTitleFromSources\(\{[\s\S]*directorySessions,[\s\S]*inventory: \{/)
    expect(sessionTitleSyncText).toMatch(
      /input\.directorySessions\?\.\(input\.directory\)\.find\(\(session\) => session\.id === input\.sessionId\)/,
    )
    expect(routeBridgeText).not.toMatch(/s\.id === id && s\.directory === wsId/)
    expect(routeBridgeText).not.toMatch(/s\.id === meta\.sessionId && s\.directory === meta\.directory/)
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

    expect(inventory).toMatch(/loadSessionInventory/)
    expect(inventory).toMatch(/reloadSessionInventory/)
    expect(inventory).toMatch(/loadMoreSessionInventoryWorkspace/)
    expect(inventory).toMatch(/useSessionInventoryActions/)
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
    expect(rail).toMatch(/useSessionInventoryActions/)
    expect(rail).toMatch(/sessionInventoryActions\.loadMoreWorkspace/)
    expect(rail).toMatch(/sessionInventoryActions\.reloadWorkspace/)
    expect(rail).not.toMatch(/useGlobalSync/)
    expect(rail).not.toMatch(/globalSync/)
    expect(layout).toMatch(/useSessionInventoryActions/)
    expect(layout).toMatch(/sessionInventoryActions\.load\(\)/)
    expect(controller).toMatch(/useSessionInventoryActions/)
    expect(controller).toMatch(/sessionInventoryActions\.reloadWorkspace\(\)/)
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
    expect(route).not.toMatch(/\brouteWorkspaceId\b/)
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
      "app/workbench/titlebar/titlebar.tsx",
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

  test("surface route matching uses decoded route workspace keys, not base64 route strings", async () => {
    const text = await Bun.file(path.join(root, "app/workbench/state/surface-route.ts")).text()
    const actions = await Bun.file(path.join(root, "app/workbench/actions/open-surface-actions-ui.ts")).text()
    const shared = await Bun.file(path.join(root, "app/workbench/actions/shared.ts")).text()

    expect(text).not.toMatch(/base64Encode/)
    expect(text).toMatch(/routeWorkspaceKey/)
    expect(text).toMatch(/routeMatchesSurface\(input\.route, dir, input\.surface, input\.routeWorkspaceKey\)/)
    expect(actions).toMatch(/props\.routeDirectory\(\)/)
    expect(actions).toMatch(/routeMatchesSurface\(props\.params, workspaceDir, tab, props\.routeDirectory\(\)\)/)
    expect(shared).toMatch(/routeDirectory:\s*Accessor<string \| undefined>/)
  })

  test("route intent warms workspace inventory without child-store creation", async () => {
    const text = await Bun.file(path.join(root, routeIntent)).text()
    const routeBridge = await Bun.file(path.join(root, "app/workbench/state/route-bridge.tsx")).text()
    const state = await Bun.file(path.join(root, appShellState)).text()

    expect(text).toMatch(/warmWorkspace\?:/)
    expect(routeBridge).toMatch(/warmWorkspace: \(directory\) =>/)
    expect(state).toMatch(/useDirectorySessionCacheActions/)
    expect(state).toMatch(/directorySessionCacheActions\.ensure/)
    expect(text).not.toMatch(/globalSync/)
    expect(text).not.toMatch(/globalSync\.child/)
    expect(text).not.toMatch(/input\.globalSync\.child/)
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
    expect(text).toMatch(/registeredConversationSnapshot/)
    expect(text).toMatch(/useSessionSyncOptional/)
    expect(text).toMatch(/sessionSync\?\.syncSession\?\.\(id\)/)
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

  test("AgentHarnessSelector reads pane identity only from explicit props", async () => {
    const text = await Bun.file(path.join(root, agentHarnessSelector)).text()

    expect(text).not.toMatch(/@solidjs\/router/)
    expect(text).not.toMatch(/\buseParams\b/)
    expect(text).not.toMatch(/\buseSessionParams\b/)
    expect(text).not.toMatch(/\bbase64Decode\b/)
  })

  test("session command registration receives session identity from SessionPage", async () => {
    const text = await Bun.file(path.join(root, sessionCommandsHook)).text()

    expect(text).not.toMatch(/\buseParams\b/)
    expect(text).not.toMatch(/\bbase64Decode\b/)
    expect(text).toMatch(/sessionId:\s*Accessor<string \| undefined>/)
    expect(text).toMatch(/directory:\s*Accessor<string>/)
    expect(text).not.toMatch(/sync\.data\.(?:message|part)/)
    expect(text).not.toMatch(/sync\.data\.session_status/)
    expect(text).toMatch(/registeredConversationUserMessages/)
    expect(text).toMatch(/registeredConversationSnapshot/)
  })

  test("SessionPage does not keep a route-shaped params compatibility proxy", async () => {
    const text = await Bun.file(path.join(root, sessionPage)).text()

    expect(text).not.toMatch(/Backward-compatible params proxy/)
    expect(text).not.toMatch(/const\s+params\s*=/)
    expect(text).not.toMatch(/params\.(?:id|dir)/)
  })

  test("SessionPage reads project inventory through query options", async () => {
    const text = await Bun.file(path.join(root, sessionPage)).text()

    expect(text).toMatch(/useQueryOptions/)
    // Project inventory is read through query options. The reactive
    // `useQuery(() => queryOptions.projects())` is the canonical reader; the
    // incidental imperative `queryClient.fetchQuery(queryOptions.projects())`
    // warm-up lived inside the old prepareWorkspaceRuntime pre-connect effect,
    // which moved to the WorkspaceConnection authority (WorkspaceGate).
    expect(text).toMatch(/queryOptions\.projects\(\)/)
    expect(text).toMatch(/useQuery\(\(\) => queryOptions\.projects\(\)\)/)
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

  test("DirectoryScope reads pane identity only from explicit props", async () => {
    const text = await Bun.file(path.join(root, directoryScope)).text()

    expect(text).not.toMatch(/\buseSessionParams\b/)
    expect(text).not.toMatch(/not in split mode/)
    expect(text).toMatch(/sessionId\?:\s*Accessor<string \| undefined>/)
    expect(text).toMatch(/surfaceId\?:\s*Accessor<string \| undefined>/)
    expect(text).toMatch(/active\?:\s*Accessor<boolean>/)
    expect(text).toMatch(/workspaceReady:\s*Accessor<boolean>/)
    expect(text).toMatch(/directorySessionCacheQueryOptions/)
    expect(text).toMatch(/sessionCacheQuery\.data/)
    expect(text).not.toMatch(/WorkspaceScopeChild/)
    expect(text).not.toMatch(/props\.workspaceChild\(\)/)
    expect(text).not.toMatch(/useWorkspaceScopeOptional/)
    expect(text).not.toMatch(/useWorkspaceScopeRegistryOptional/)
    expect(text).not.toMatch(/directoryScopeWorkspaceKey/)
    expect(text).not.toMatch(/\buseSync\b/)
    expect(text).not.toMatch(/<SyncProvider\b/)
    expect(text).not.toMatch(/sync\.data/)
    expect(text).not.toMatch(/sync\.session/)
    expect(text).toMatch(/<DataProvider/)
    expect(text).toMatch(/agentListQuery/)
    expect(text).toMatch(/agent:\s*agentQuery\.data \?\? \[\]/)
    expect(text).toMatch(/fetchSessionMessagesByTransport/)
    expect(text).toMatch(/hydrateConversationPage/)
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
    expect(local).toMatch(/configQuery/)
    expect(local).toMatch(/useQuery/)
    expect(local).toMatch(/localSelectionHandoffQueryKey/)
    expect(local).toMatch(/firstConnectedModel/)
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
    expect(file).toMatch(/clearFileRequestCache/)
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
    expect(fileRequestCache).toMatch(/"file-read-request"/)
    expect(fileRequestCache).toMatch(/"file-tree-request"/)
    expect(local).toMatch(/agentListQuery\(\{/)
    expect(local).toMatch(/configQuery\(\{[\s\S]*baseUrl: sdk\.url,[\s\S]*directory: sdk\.directory/)
    expect(local).not.toMatch(/sync\.data\.agent/)
    expect(local).not.toMatch(/sync\.data\.config/)
  })

  test("PromptInput derives default provider model fallback without selection write-back", async () => {
    const input = await Bun.file(path.join(root, promptInput)).text()
    const submit = await Bun.file(path.join(root, promptSubmit)).text()
    const local = await Bun.file(path.join(root, localContextOwner)).text()
    const strategy = await Bun.file(path.join(root, promptModelStrategy)).text()
    const toolbar = await Bun.file(path.join(root, promptToolbarState)).text()

    expect(local).toMatch(/selected\(\)\s*\{\s*return scope\(\)\?\.model\s*\}/)
    expect(local).toMatch(/currentSource\(\)\s*\{[\s\S]{0,80}currentModelKey\(\)\?\.source/)
    expect(local).toMatch(/sessionConfigSelectionQuery/)
    expect(strategy).toMatch(/hasSelection:\s*boolean/)
    expect(strategy).toMatch(/providerLoading:\s*boolean/)
    expect(strategy).toMatch(/existingSession\?:\s*boolean/)
    expect(strategy).toMatch(/restoreLoading\?:\s*boolean/)
    expect(strategy).toMatch(/type:\s*"selected";\s*fallback:\s*false/)
    expect(strategy).toMatch(/type:\s*"invalid-selected";\s*fallback:\s*true/)
    expect(strategy).toMatch(/type:\s*"hydrating";\s*fallback:\s*false/)
    expect(strategy).toMatch(/type:\s*"needs-selection";\s*fallback:\s*false/)
    expect(strategy).toMatch(/type:\s*"uninitialized";\s*fallback:\s*true/)
    expect(strategy).toMatch(
      /if \(input\.hasSelection && \(input\.providerLoading \|\| input\.restoreLoading\)\) return \{ type: "selected", fallback: false \}/,
    )
    expect(strategy).toMatch(
      /if \(input\.providerLoading \|\| input\.restoreLoading\) return \{ type: "hydrating", fallback: false \}/,
    )
    expect(strategy).toMatch(/if \(input\.hasSelection\) return \{ type: "invalid-selected", fallback: true \}/)
    expect(strategy).toMatch(/if \(input\.existingSession\) return \{ type: "needs-selection", fallback: false \}/)
    expect(toolbar).toMatch(/promptModelFallbackState/)
    expect(toolbar).toMatch(/currentModelSource:\s*Accessor<string \| undefined>/)
    expect(toolbar).toMatch(/hasSelectedModel:\s*Accessor<boolean>/)
    expect(toolbar).toMatch(/modelRestorePending:\s*Accessor<boolean>/)
    expect(toolbar).toMatch(/fallbackModel:\s*Accessor<PromptModel \| undefined>/)
    expect(toolbar).toMatch(/existingSession:\s*Accessor<boolean>/)
    expect(input).toMatch(/createPromptToolbarState/)
    expect(input).toMatch(/existingSession:\s*\(\) => !!resolvedSessionId\(\) && resolvedSessionId\(\) !== "new"/)
    expect(input).toMatch(/currentModelSource:\s*local\.model\.currentSource/)
    expect(input).toMatch(/hasSelectedModel:\s*\(\) => !!local\.model\.selected\(\)/)
    expect(input).toMatch(/providerLoading:\s*providers\.loading/)
    expect(input).toMatch(/modelRestorePending:\s*local\.model\.restorePending/)
    expect(toolbar).toMatch(/if \(current && input\.currentModelSource\(\) !== "fallback"\) return current/)
    expect(toolbar).toMatch(/if \(shouldUseFallbackModel\(\)\) return fallbackModel\(\)/)
    expect(input).not.toMatch(/shouldApply(?:Agent|Model)Fallback/)
    expect(input).not.toMatch(/fallbackGuardScopeKey/)
    expect(toolbar).not.toMatch(/shouldUseFallbackModel[\s\S]{0,300}local\.model\.set\(/)
    expect(input).toMatch(/createModelSelectionPicker/)
    expect(input).toMatch(
      /write:\s*\(model, options\) => writeOpenCodeDraftModel\(\{[\s\S]{0,400}write:\s*local\.model\.set/,
    )
    expect(input).toMatch(
      /fallbackModel:\s*\(\) => toolbarState\.shouldUseFallbackModel\(\) \? toolbarState\.fallbackModel\(\) : undefined/,
    )
    expect(input).not.toMatch(/fallbackModel:\s*\(\) => fallbackModel\(\)/)
    expect(strategy).toMatch(/export function selectRuntimeModel/)
    expect(submit).toMatch(/resolveSubmittedConfig/)
    expect(submit).toMatch(/modelForSubmit:\s*\(selected\) => modelForSubmit\(sessionDirectory, selected\)/)
    expect(submit).toMatch(/fallbackModel:\s*isNewSession \? input\.fallbackModel\?\.\(\) : undefined/)
    expect(submit).toMatch(/allowModelFallback:\s*isNewSession/)
    expect(submit).not.toMatch(/function selectRuntimeModel\(/)
    expect(submit).not.toMatch(/function runtimeProviders\(/)
    expect(submit).not.toMatch(/id: "big-pickle"/)
  })

  test("harness submit model stays on canonical ModelKey boundaries", async () => {
    const harness = await Bun.file(path.join(root, harnessConfigStore)).text()
    const submit = await Bun.file(path.join(root, promptSubmit)).text()
    const submitTypes = await Bun.file(path.join(root, "features/session/submit/types.ts")).text()
    const submitResolve = await Bun.file(path.join(root, "features/session/submit/resolve.ts")).text()
    const strategy = await Bun.file(path.join(root, promptModelStrategy)).text()

    expect(harness).toMatch(/harnessModelKeyForSubmit/)
    expect(harness).toMatch(/harnessModelKeyForSubmit:\s*harnessStore\.harnessModelKeyForSubmit/)
    expect(harness).toMatch(/harnessModelNameForSubmit:\s*harnessStore\.harnessModelNameForSubmit/)
    expect(harness).not.toMatch(/harnessModelForSubmit/)

    expect(submit).toMatch(
      /harnessModelKey:\s*selectedHarnessMode\(scope\)\s*\?\s*harnessController\.modelKeyForSubmit\(scope\)\s*:\s*undefined/,
    )
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
    expect(context).toMatch(/queryKeys\.controlPlane\.projects\(globalSDK\.url\)/)
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

  test("content rendering uses the shared surface contribution registry", async () => {
    const renderer = await Bun.file(path.join(root, "app/workbench/content/index.tsx")).text()
    const contentSurfaces = await Bun.file(path.join(root, "app/integrations/first-party-content-surfaces.tsx")).text()
    const contentSurfaceTest = await Bun.file(
      path.join(root, "app/integrations/first-party-content-surfaces.test.ts"),
    ).text()

    expect(renderer).toMatch(/const current = m\(\)/)
    expect(renderer).toMatch(
      /contentSurface\(current\.type,\s*\{\s*sessionRef:\s*current\.content\?\.sessionRef\s*\}\)/,
    )
    expect(renderer).toMatch(/state\.meta\.ids\(\)/)
    expect(renderer).not.toMatch(/firstPartyContentSurface/)
    expect(contentSurfaces).toMatch(/createContributionRegistry\(\{ surfaces: surfaces as SurfaceContribution\[\] \}\)/)
    expect(contentSurfaces).toMatch(/registerContentSurface/)
    expect(contentSurfaces).toMatch(/surface:\s*ContentType \| string/)
    expect(contentSurfaceTest).toMatch(/surface\.content\.agent-review/)
    expect(contentSurfaceTest).toMatch(/slot:\s*"ext:agent-review"/)
    expect(contentSurfaceTest).toMatch(/gate:\s*\{ backing: "real" \}/)
  })

  test("Claxedo command context owns the typed command bus bridge", async () => {
    const command = await Bun.file(path.join(root, commandContext)).text()

    expect(await Bun.file(path.join(root, "overrides/app/providers/command.tsx")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, commandContext)).exists()).toBe(true)
    expect(command).toMatch(/CommandBusProvider/)
    expect(command).toMatch(/legacyCommandTrigger/)
    expect(command).toMatch(/serverCommandTriggerFromEvent/)
    expect(command).toMatch(/agentCommandFromEvent/)
    expect(command).toMatch(/trustedAgentContributionBundleFromEvent/)
    expect(command).toMatch(/contentSurfaceRegistry\.addTrustedAgentContributions/)
    expect(command).toMatch(/remote-agent\.command\.execute/)
    expect(command).toMatch(/voice-agent\.command\.execute/)
    expect(command).toMatch(/trusted-agent\.contributions\.register/)
    expect(command).toMatch(/tui\.command\.execute/)
    expect(command).toMatch(/useGlobalSDK/)
    // 007 Tier E: upstream command definitions are now vendored in-repo as
    // ./command-palette (packages/app coupling removed), not re-exported from
    // ../../../app/src/context/command.
    expect(command).toMatch(/export \* from "\.\/command-palette"/)
    expect(command).not.toMatch(/\.\.\/\.\.\/\.\.\/app\/src\/context\/command/)
  })

  test("Claxedo platform context owns desktop and auth platform capabilities", async () => {
    const platform = await Bun.file(path.join(root, platformContext)).text()

    expect(await Bun.file(path.join(root, "overrides/platform/runtime/platform-provider.tsx")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, platformContext)).exists()).toBe(true)
    expect(platform).toMatch(/getAuthToken\?\(\): Promise<string \| null>/)
    expect(platform).toMatch(/recordFatalRendererError\?/)
    expect(platform).toMatch(/runDesktopMenuAction\?/)
    // The reorg inverted the dependency: the platform context now DEFINES
    // DesktopMenuAction itself, and app/entry/desktop-menu re-exports it from
    // here — strictly stronger ownership than the old import from ../desktop-menu.
    expect(platform).toMatch(/export type DesktopMenuAction =/)
    expect(platform).not.toMatch(/from "[^"]*desktop-menu"/)
    const desktopMenu = await Bun.file(path.join(root, "app/entry/desktop-menu.ts")).text()
    expect(desktopMenu).toMatch(/export type \{ DesktopMenuAction \} from "@\/platform\/runtime\/platform-provider"/)
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
    expect(index).toMatch(/@\/platform\/i18n\/provider/)
    expect(index).toMatch(/loadLocaleDict/)
    expect(index).toMatch(/normalizeLocale/)
    expect(index).toMatch(/type Locale/)
    expect(offenders).toEqual([])
  })

  test("override resolver stays deleted after first-party aliases replace overrides", async () => {
    const appViteConfig = await Bun.file(path.join(root, "../vite.cloud.config.ts")).text()
    const appVitestConfig = await Bun.file(path.join(root, "../vitest.config.ts")).text()
    const appTsconfig = await Bun.file(path.join(root, "../tsconfig.json")).text()
    const desktopRenderer = await Bun.file(path.resolve(root, "../../claxedo-desktop/vite.renderer.ts")).text()
    const desktopTsconfig = await Bun.file(path.resolve(root, "../../claxedo-desktop/tsconfig.json")).text()
    // The overrides tombstone directory itself is now deleted (previously an
    // empty README-only dir); a missing dir makes Bun.Glob.scan reject, which
    // for this invariant is an even stronger "no override files exist" — treat
    // the absent directory as an empty override set.
    const overrideFiles = await Array.fromAsync(
      new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: path.join(root, "overrides") }),
    ).catch(() => [] as string[])
    const contentSurfaces = await Bun.file(path.join(root, "app/integrations/first-party-content-surfaces.tsx")).text()

    // 007 Tier E: packages/app is deleted, so the old "no override shadows an
    // upstream file" parity checks (which globbed packages/app/src) are moot.
    // What still matters is that the overrides dir is gone and every config
    // resolves @/ to claxedo-app's own src (asserted below).
    expect(overrideFiles).toEqual([])
    expect(contentSurfaces).toMatch(/firstPartyContentSurfaces/)

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
    expect(appViteConfig).toMatch(/plugins:\s*\[solidPlugin\(\), tailwindcss\(\)\]/)
    expect(appVitestConfig).not.toMatch(/firstPartyOwners/)
    expect(appVitestConfig).not.toMatch(/\.\.\/app\/src/)
    expect(appVitestConfig).toMatch(
      /find: "@\/", replacement: normalizePath\(fileURLToPath\(new URL\("\.\/src\/", import\.meta\.url\)\)\)/,
    )
    expect(appVitestConfig).toMatch(
      // as-any: regex asserts upstream text still contains this compatibility cast.
      /plugins:\s*\[solid\(\) as unknown as NonNullable<UserConfig\["plugins"\]>\[number\]\]/,
    )
    expect(appTsconfig).not.toMatch(/\.\.\/app\/src/)
    expect(appTsconfig).toMatch(/"@\/\*": \["\.\/src\/\*"\]/)

    expect(desktopRenderer).not.toMatch(/name:\s*"claxedo-override-resolver"/)
    expect(desktopRenderer).not.toMatch(/firstPartyOwners/)
    expect(desktopRenderer).not.toMatch(/\.\.\/app\/src/)
    expect(desktopRenderer).toMatch(/plugins:\s*\[solidPlugin\(\), tailwindcss\(\)\]/)
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

  test("SessionPaneScope prefers SessionRef as pane session identity", async () => {
    const text = await Bun.file(path.join(root, sessionPaneScope)).text()

    expect(text).toMatch(/props\.sessionRef\?\.\(\)\?\.sessionId\s*\?\?\s*props\.sessionId\?\.\(\)/)
    expect(text).toMatch(/useWorkspaceScopeRegistryOptional/)
    expect(text).toMatch(/sessionPaneWorkspaceKey/)
    expect(text).not.toMatch(/directoryScopeWorkspaceKey/)
    expect(text).not.toMatch(/useGlobalSync/)
    expect(text).toMatch(/workspaceScopes\?\.refreshDirectory\(directory, harnessType\)/)
    // Readiness is derived from scopeFor(workspaceKey()); Wave 2 hoisted it from
    // an inline JSX arrow into a named workspaceReady() const wired into the scope.
    expect(text).toMatch(
      /const workspaceReady = \(\) => \{[\s\S]*return !!workspaceScopes\?\.scopeFor\(workspaceKey\(\)\)/,
    )
    expect(text).toMatch(/workspaceReady=\{workspaceReady\}/)
    expect(text).toMatch(/refreshDirectory=\{refreshDirectory\}/)
  })

  test("SessionRef host placement is explicit and immutable at owner boundaries", async () => {
    const offenders: string[] = []
    for (const file of await files(root)) {
      const text = await Bun.file(path.join(root, file)).text()
      if (!sessionRefHostOwnerBoundary.has(file) && /host:\s*["'](?:central|workspace)["']\s*[,}]/.test(text)) {
        offenders.push(`${file}: constructs SessionRef host outside identity/orchestration owner`)
      }
    }

    const identity = await Bun.file(path.join(root, sessionRefIdentity)).text()
    const orchestration = await Bun.file(path.join(root, "app/workbench/state/orchestration.ts")).text()
    const persistence = await Bun.file(path.join(root, "app/workbench/state/persistence.ts")).text()
    const routeBridge = await Bun.file(path.join(root, "app/workbench/state/route-bridge.tsx")).text()
    const rail = await Bun.file(path.join(root, appShellLayout)).text()
    const sidebar = await Bun.file(path.join(root, railSidebar)).text()
    const actionsShared = await Bun.file(path.join(root, claxedoActionShared)).text()
    const sessionActions = await Bun.file(path.join(root, claxedoSessionActions)).text()
    const workspaceActions = await Bun.file(path.join(root, claxedoWorkspaceActions)).text()
    const sessionContent = await Bun.file(path.join(root, "features/session/ui/content/session-content.tsx")).text()
    const contextContent = await Bun.file(path.join(root, "app/workbench/content/context-content.tsx")).text()
    const pageContent = await Bun.file(path.join(root, "features/documents/ui/content/page-content.tsx")).text()
    const terminalContent = await Bun.file(path.join(root, "features/terminal/ui/content/terminal-content.tsx")).text()
    expect(identity).toMatch(/readonly host: SessionHost/)
    expect(identity).toMatch(/readonly toolSandbox\?: SandboxRef/)
    expect(identity).toMatch(/readonly workspaceId\?: string/)
    expect(identity).toMatch(/readonly cwd\?: string/)
    expect(identity).toMatch(/centralSessionRef/)
    expect(identity).toMatch(/localSessionRef/)
    expect(identity).toMatch(/workspaceBackedSessionRef/)
    expect(identity).toMatch(/sessionRefForWorkspaceSession/)
    expect(identity).toMatch(/retargetSessionRef/)
    expect(identity).not.toMatch(/retargetSessionRef\(input: \{[\s\S]*directory\?: string/)
    expect(identity).not.toMatch(/sessionRefForWorkspaceSession\(\{[\s\S]*sessionId,[\s\S]*directory: input\.directory/)
    expect(identity).not.toMatch(/sessionRefForPane/)
    expect(orchestration).not.toMatch(/sessionRefForPane/)
    expect(orchestration).not.toMatch(/sessionRefForPayload/)
    expect(orchestration).not.toMatch(/sessionRefForSession/)
    expect(orchestration).toMatch(/export type OpenSessionOptions = \{ focus\?: boolean; sessionRef\?: SessionRef \}/)
    expect(orchestration).toMatch(/explicitSessionRef \?\? existing\.content\?\.sessionRef/)
    expect(orchestration).toMatch(/const sessionRef = opts\?\.sessionRef/)
    expect(orchestration).toMatch(/sameWorkspaceSession\(m, directory, sessionId, opts\?\.sessionRef\)/)
    expect(orchestration).not.toMatch(
      /m\.type === "session" && m\.directory === directory && m\.sessionId === sessionId/,
    )
    expect(orchestration).not.toMatch(/opts\?\.sessionRef \?\? sessionRefForPayload\(directory, sessionId\)/)
    expect(orchestration).not.toMatch(
      /input\.sessionRef \?\? sessionRefForPayload\(input\.directory, input\.sessionId\)/,
    )
    expect(orchestration).toMatch(/input\.sessionRef \? \{ sessionRef: input\.sessionRef \} : \{\}/)
    expect(orchestration).toMatch(/centralSessionRef\(\{ sessionId \}\)/)
    expect(persistence).toMatch(/missingRequiredSessionRef/)
    expect(persistence).not.toMatch(/backfillSessionRef/)
    expect(persistence).not.toMatch(/sessionRefForPane/)
    expect(routeBridge).toMatch(
      /draft\?\.content\?\.sessionRef \?\?\s*sessionRefForWorkspaceSession\(\{[\s\S]*sessionId: event\.sessionID,[\s\S]*directory: event\.directory/,
    )
    expect(routeBridge).toMatch(/sessionRefForWorkspaceSession/)
    expect(rail).not.toMatch(/sessionRefForPane/)
    expect(rail).not.toMatch(/signedWorkspaceFromProjects/)
    expect(sidebar).toMatch(/sessionRefForWorkspaceSession/)
    expect(sidebar).toMatch(/\{ focus: false, sessionRef: sessionRef\(\) \}/)
    expect(actionsShared).toMatch(/sessionRefForActionWorkspace/)
    expect(actionsShared).toMatch(/sessionRefForWorkspaceSession/)
    expect(sessionActions).toMatch(/sessionRefForActionWorkspace/)
    expect(workspaceActions).toMatch(/sessionRefForActionWorkspace/)
    expect(sessionContent).toMatch(/content\.sessionRef/)
    expect(sessionContent).toMatch(/retargetSessionRef/)
    expect(sessionContent).not.toMatch(/sessionRefForPane/)
    expect(sessionContent).not.toMatch(/signedWorkspaceFromProjects/)
    expect(sessionContent).not.toMatch(/useShellQueryOptions/)
    expect(contextContent).toMatch(/content\?\.sessionRef/)
    expect(contextContent).not.toMatch(/sessionRefForPane/)
    expect(contextContent).not.toMatch(/signedWorkspaceFromProjects/)
    expect(contextContent).not.toMatch(/useShellQueryOptions/)
    expect(pageContent).toMatch(/content\?\.sessionRef/)
    expect(pageContent).toMatch(/retargetSessionRef/)
    expect(pageContent).not.toMatch(/sessionRefForPane/)
    expect(pageContent).not.toMatch(/signedWorkspaceFromProjects/)
    expect(pageContent).not.toMatch(/useShellQueryOptions/)
    expect(terminalContent).toMatch(/content\?\.sessionRef/)
    expect(terminalContent).not.toMatch(/sessionRefForPane/)
    expect(terminalContent).not.toMatch(/signedWorkspaceFromProjects/)
    expect(terminalContent).not.toMatch(/useShellQueryOptions/)
    expect(offenders).toEqual([])
  })

  test("open session registry is keyed by root session id", async () => {
    const text = await Bun.file(path.join(root, openSessionsRegistry)).text()

    expect(await Bun.file(path.join(root, "context/global-sync/open-sessions.ts")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, openSessionsRegistry)).exists()).toBe(true)
    expect(text).toMatch(/const refs = new Set<string>\(\)/)
    expect(text).toMatch(/refs\.add\(ref\.sessionId\)/)
    expect(text).toMatch(/export function hasOpenSession\(sessionId: string\)/)
    expect(text).not.toMatch(/\$\{ref\.directory\}/)
    expect(text).not.toMatch(/function key\(/)
  })

  test("existing session pane preferences are keyed by root session id", async () => {
    const text = await Bun.file(path.join(root, panePreferences)).text()
    const harnessPolicy = await Bun.file(path.join(root, harnessStorePolicy)).text()

    expect(text).toMatch(/return `session:\$\{input\.sessionId\}`/)
    expect(text).not.toMatch(/session:\$\{input\.directory/)
    expect(harnessPolicy).toMatch(/export const harnessScope = panePreferenceScope/)
    expect(harnessPolicy).toMatch(/return `\$\{base\}\\n\$\{input\.sessionId\}`/)
    expect(harnessPolicy).not.toMatch(/\$\{input\?\.directory \?\? ""\}\\n\$\{input\?\.sessionId/)
    expect(harnessPolicy).not.toMatch(/\$\{base\}\\n\$\{input\.directory\}\\n\$\{input\.sessionId\}/)
  })

  test("generic auth fetch does not own workspace session transport routing", async () => {
    const api = await Bun.file(path.join(root, "platform/api/api.ts")).text()
    const globalSdk = await Bun.file(path.join(root, "app/providers/global-sdk/provider.tsx")).text()

    expect(api).not.toMatch(/workspaceRuntimeSessionFetch/)
    expect(api).not.toMatch(/createTransport/)
    expect(api).not.toMatch(/signedWorkspaceFromProjects/)
    expect(api).not.toMatch(/queryClient/)
    expect(api).not.toMatch(/queryKeys/)
    expect(globalSdk).toMatch(/createGlobalSdkFetch/)
    expect(globalSdk).toMatch(/createTransport/)
    expect(globalSdk).toMatch(/signedWorkspaceFromProjects/)
  })

  test("session status telemetry is keyed by root session id", async () => {
    const text = await Bun.file(path.join(root, sessionStatusTelemetry)).text()
    const listener = await Bun.file(path.join(root, agentStatusListener)).text()

    expect(text).toMatch(/function statusKey\(sessionID: string\)/)
    expect(text).toMatch(/return sessionID/)
    expect(text).toMatch(/sessionID: key/)
    expect(text).toMatch(/latestObservedDirectory/)
    expect(text).not.toMatch(/\$\{input\.directory \?\? ""\}\\n\$\{input\.sessionID\}/)
    expect(text).not.toMatch(/key\.split\("\\n"/)
    expect(listener).toMatch(/m\.type === "session" && m\.sessionId === sessionId/)
    expect(listener).not.toMatch(/m\.type === "session" && m\.directory === directory && m\.sessionId === sessionId/)
  })

  test("session controller caches existing session state by root session id", async () => {
    const text = await Bun.file(path.join(root, sessionController)).text()

    expect(text).toMatch(/function sessionCapabilitiesKey\(sessionID: string\)/)
    expect(text).toMatch(/return shellDataKeys\.sessionId\(sessionID, "transport-capabilities"\)/)
    expect(text).toMatch(/function sessionTransportRequestKey\(input: \{[\s\S]{0,80}sessionID: string/)
    expect(text).toMatch(/return shellDataKeys\.sessionId\(\s*input\.sessionID,\s*"transport-session-request"/)
    expect(text).toMatch(/function sessionTodoTransportRequestKey\(input: \{[\s\S]{0,80}sessionID: string/)
    expect(text).toMatch(/return shellDataKeys\.sessionId\(\s*input\.sessionID,\s*"todo-request"/)
    expect(text).not.toMatch(/function keyFor\(directory: string, sessionID: string\)/)
    expect(text).not.toMatch(/\$\{directory\}\\n\$\{sessionID\}/)
    expect(text).not.toMatch(/keyFor\(input\.directory\(\), sessionID\)/)
    expect(text).not.toMatch(/keyFor\(directory, sessionID\)/)
  })

  test("surface route mirroring uses canonical session routes for existing sessions", async () => {
    const text = await Bun.file(path.join(root, "app/workbench/state/surface-route.ts")).text()
    const layout = await Bun.file(path.join(root, appShellRouteSync)).text()

    expect(text).toMatch(/canonicalSessionRoute\(sessionId\)/)
    expect(text).not.toMatch(/legacySessionRoute\(dir, routeSessionId/)
    // Wave 2 derives the mirror target from params.sessionId ?? params.id via a
    // local before building the canonical route; still canonical, never legacy.
    expect(layout).toMatch(/const sessionId = input\.params\.sessionId \?\? input\.params\.id/)
    expect(layout).toMatch(/canonicalSessionRoute\(sessionId\)/)
    expect(layout).not.toMatch(/legacySessionRoute\(meta\.directory, params\.id\)/)
  })

  test("created-session handoff navigates with canonical session routes", async () => {
    const handoff = await Bun.file(path.join(root, "features/session/submit/handoff.ts")).text()
    const payload = await Bun.file(path.join(root, "app/workbench/state/session-content-payload.ts")).text()
    // The new-session submit flow (and its navigation assertions) was carved
    // out of submit.test.ts into submit.new-session.test.ts during WP-B4.
    const submitTest = await Bun.file(path.join(root, "features/session/composer/ui/submit.new-session.test.ts")).text()

    expect(await Bun.file(path.join(root, "overrides/features/session/composer/ui/submit.test.ts")).exists()).toBe(
      false,
    )
    // Connection-scoping made created-session navigation host-aware via a
    // createdSessionRoute helper: central-host sessions keep the canonical
    // sessionRoute, workspace-host sessions use the typed workspaceSessionRoute
    // (the sanctioned typed route — required by the draft-session surfaces test
    // below). The real guard is "never a legacy base64 route string", still
    // asserted via base64Encode below.
    expect(handoff).toMatch(
      /input\.sessionRef\?\.host === "central"[\s\S]*sessionRoute\(input\.sessionID\)[\s\S]*workspaceSessionRoute\(input\.sessionDirectory, input\.sessionID\)/,
    )
    expect(handoff).toMatch(/input\.navigate\(createdSessionRoute\(\{/)
    expect(handoff).toMatch(/sessionContentPayload/)
    expect(handoff).toMatch(
      /openSession\([\s\S]*input\.sessionDirectory,[\s\S]*input\.session\.id,[\s\S]*"Session",[\s\S]*\{ sessionRef: input\.sessionRef \}/,
    )
    expect(handoff).not.toMatch(/sessionRefForPane/)
    expect(handoff).not.toMatch(/base64Encode\([^)]*\).*\/session/)
    expect(payload).not.toMatch(/sessionRefForPane/)
    expect(payload).toMatch(/sessionRef\?: SessionRef/)
    expect(payload).toMatch(/\.\.\.\(input\.sessionRef \? \{ sessionRef: input\.sessionRef \} : \{\}\)/)
    expect(submitTest).toMatch(/navigate:\/w\/ws_1\/session\/session-1/)
    expect(submitTest).not.toMatch(/navigate:\/ws_1\/session\/session-1/)
  })

  test("workspace browse fallbacks use typed workspace routes", async () => {
    const migrated = [
      "app/routes/home.tsx",
      "app/providers/notification.tsx",
      appShellRouteSync,
      "app/workbench/state/surface-route.ts",
    ]

    for (const file of migrated) {
      const text = await Bun.file(path.join(root, file)).text()
      expect(text).toMatch(/workspaceRoute/)
      expect(text).not.toMatch(/`\s*\/\$\{base64Encode\([^)]*\)\}\s*`/)
    }
  })

  test("workspace directory alias canonicalization is shared from signed-workspace identity", async () => {
    const globalSdk = await Bun.file(path.join(root, "app/providers/global-sdk/provider.tsx")).text()
    const signedWorkspace = await Bun.file(path.join(root, "platform/runtime/agent/signed-workspace.ts")).text()

    expect(await Bun.file(path.join(root, "overrides/app/providers/global-sdk/provider.tsx")).exists()).toBe(false)
    expect(globalSdk).toMatch(/sameWorkspaceDirectory/)
    expect(globalSdk).toMatch(/sessionWorkspaceRuntimeRef/)
    expect(globalSdk).toMatch(/function runtimeSessionKey\(sessionID: string\)/)
    expect(globalSdk).toMatch(/return sessionID/)
    expect(globalSdk).toMatch(/const key = `\$\{input\.sessionId\}:\$\{assistantMessageId\}`/)
    expect(globalSdk).toMatch(/directory: input\.directory/)
    expect(globalSdk).toMatch(/return `session\.status:\$\{payload\.properties\.sessionID\}`/)
    expect(globalSdk).not.toMatch(/workspaceIdFromDirectoryRef/)
    expect(globalSdk).not.toMatch(/\$\{directory\}\\n\$\{sessionID\}/)
    expect(globalSdk).not.toMatch(/`\$\{input\.directory\}:\$\{input\.sessionId\}:\$\{assistantMessageId\}`/)
    expect(globalSdk).not.toMatch(/`session\.status:\$\{directory\}:\$\{payload\.properties\.sessionID\}`/)
    expect(globalSdk).not.toMatch(/function canonicalDirectoryKey/)
    expect(globalSdk).not.toMatch(/startsWith\("\/private\/var\/"\)/)
    expect(signedWorkspace).toMatch(/workspaceDirectoryAliasKey/)
    expect(signedWorkspace).not.toMatch(/canonicalDirectoryKey/)
  })

  test("page surface routes use typed workspace page routes", async () => {
    const migrated = [
      "features/documents/actions/page-actions.ts",
      "app/workbench/actions/open-surface-actions-ui.ts",
      "app/workbench/state/surface-route.ts",
    ]

    const app = await Bun.file(path.join(root, "app/entry/app.tsx")).text()
    expect(app).toMatch(/path="\/w\/:workspaceId\/page\/:pageId"/)

    for (const file of migrated) {
      const text = await Bun.file(path.join(root, file)).text()
      if (file === "app/workbench/state/surface-route.ts") {
        expect(text).toMatch(/workspacePageRoute/)
        expect(text).not.toMatch(/legacyWorkspaceRoute/)
      }
      expect(text).not.toMatch(/`\$\{?workspaceRoute\([^)]*\)\}?\/page\//)
      expect(text).not.toMatch(/`\/\$\{base64Encode\([^)]*\)\}\/page\/\$\{[^}]+\}`/)
      expect(text).not.toMatch(/`\/\$\{base64Encode\([^)]*\)\}\/page\/__index__`/)
    }
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
    expect(await Bun.file(path.join(root, "overrides/features/session/ui/message-timeline.tsx")).exists()).toBe(false)
    // session-screen imports the first-party message-timeline from its
    // canonical features/session/ui home, never through the retired
    // @/pages override alias; the row model is vendored as a colocated
    // sibling (packages/app was deleted in 007 Tier E).
    expect(sessionPage).toMatch(/@\/features\/session\/ui\/message-timeline/)
    expect(sessionPage).not.toMatch(/@\/pages\/session\/message-timeline/)
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
    expect(sessionPage).toMatch(/terminalScopeKey\(routeDirectory\(\)\)/)
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

    expect(text).toMatch(/setSessionPrefetch/)
    expect(text).toMatch(/runSessionPrefetch/)
    expect(text).toMatch(/prefetchSidebarSessionMessages/)
    expect(text).not.toMatch(/prefetchQueues = new Map/)
    expect(text).not.toMatch(/prefetchedByDir = new Map/)
    expect(text).not.toMatch(/prefetchFail = new Map/)
    expect(prefetch).toMatch(/function prefetchMetaKey\(sessionID: string\)/)
    expect(prefetch).toMatch(/shellDataKeys\.sessionId\(sessionID, "message-prefetch"\)/)
    expect(prefetch).toMatch(/function prefetchRequestKey\(sessionID: string, revision: number, generation: number\)/)
    expect(await Bun.file(path.join(root, "overrides/context/global-sync/session-prefetch.ts")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "platform/sync/session-prefetch.ts")).exists()).toBe(true)
    expect(prefetch).toMatch(/directory: input\.directory/)
    expect(text).toMatch(/useQueries/)
    expect(text).not.toMatch(/globalSync\.data\.project/)
    expect(text).not.toMatch(/globalSync\.project\.(?:meta|icon)/)
    expect(text).not.toMatch(/globalSync\.data\.path\.home/)
    expect(text).not.toMatch(/globalSync\.child/)
    expect(text).not.toMatch(/setStore\("message"/)
    expect(text).not.toMatch(/setStore\("part"/)
    expect(text).not.toMatch(/store\.message\[session\.id\]/)
    expect(text).not.toMatch(/sortedRootSessions\((?:dirStore|projectStore)/)
    expect(text).not.toMatch(/store\.session\s*\?\?/)
    expect(text).not.toMatch(/\$\{directory\}\\n\$\{sessionID\}/)
    expect(text).not.toMatch(/\$\{directory\}:\$\{props\.sessionID\}/)
    expect(text).not.toMatch(/\$\{currentDir\(\)\}:\$\{currentSession\}/)
    expect(text).not.toMatch(/scrollToSession\(session\.id, `\$\{session\.directory\}:\$\{session\.id\}`\)/)
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

  test("global-sync stale session cache cleanup is owned by session-cache helpers", async () => {
    const listEvents = await Bun.file(path.join(root, sessionListEvents)).text()
    const cache = await Bun.file(path.join(root, sessionCache)).text()
    const context = await Bun.file(path.join(root, globalSyncContext)).text()
    const eventIngress = await Bun.file(path.join(root, "app/integrations/session-events/event-ingress.ts")).text()
    const eventRouter = await Bun.file(path.join(root, "app/integrations/session-events/event-router.ts")).text()
    const bootstrap = await Bun.file(path.join(root, "app/boot/data/bootstrap.ts")).text()
    const projector = await Bun.file(path.join(root, directoryEventProjector)).text()
    const globalProjector = await Bun.file(path.join(root, globalEventProjector)).text()
    const statusDispatcher = await Bun.file(
      path.join(root, "features/session/store/session-status-dispatcher.ts"),
    ).text()
    const types = await Bun.file(path.join(root, "features/session/data/sync/global-sync-types.ts")).text()
    const directoryCacheManager = await Bun.file(path.join(root, "platform/sync/directory-cache-manager.ts")).text()
    const reducerImports: string[] = []
    for (const file of await files(root)) {
      const text = await Bun.file(path.join(root, file)).text()
      if (/app\/src\/context\/global-sync\/event-reducer/.test(text)) reducerImports.push(file)
    }

    expect(await Bun.file(path.join(root, "overrides/context/global-sync/session-cache.ts")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "overrides/context/global-sync/session-list-events.ts")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "overrides/context/global-sync/session-load.ts")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "overrides/platform/sync/global-sync/types.ts")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "features/session/data/sync/session-cache-cleanup.ts")).exists()).toBe(true)
    expect(await Bun.file(path.join(root, "features/session/data/sync/session-list-events.ts")).exists()).toBe(true)
    expect(await Bun.file(path.join(root, "platform/sync/session-load.ts")).exists()).toBe(true)
    expect(await Bun.file(path.join(root, "features/session/data/sync/global-sync-types.ts")).exists()).toBe(true)
    expect(await Bun.file(path.join(root, "overrides/context/global-sync/event-reducer.ts")).exists()).toBe(false)
    expect(reducerImports).toEqual([])
    expect(context).not.toMatch(/app\/src\/context\/global-sync\/event-reducer/)
    expect(listEvents).not.toMatch(/app\/src\/context\/global-sync\/event-reducer/)
    expect(context).toMatch(/createGlobalSyncEventIngress/)
    expect(eventIngress).toMatch(/applyGlobalProjectEvent/)
    expect(globalProjector).toMatch(/server\.connected/)
    expect(globalProjector).toMatch(/global\.disposed/)
    expect(globalProjector).toMatch(/project\.updated/)
    expect(listEvents).toMatch(/applyDirectorySessionCacheEvent/)
    expect(listEvents).toMatch(/cleanupDroppedSessionCaches/)
    expect(listEvents).toMatch(/Binary\.search/)
    expect(listEvents).toMatch(/trimSessions/)
    expect(listEvents).toMatch(/applyClaxedoSessionLifecycleEvent/)
    expect(listEvents).toMatch(/applySessionListEvent/)
    expect(listEvents).toMatch(/cache:\s*DirectorySessionCacheValue/)
    expect(listEvents).not.toMatch(/SetStoreFunction|Store<State>|createStore|setStore\(/)
    expect(listEvents).not.toMatch(/sessionCacheSessionIDs/)
    expect(listEvents).not.toMatch(/promptSessionStatusMeta\(sessionId\)\?\.started/)
    expect(listEvents).not.toMatch(/cachedDirectorySession\(directory, sessionId\)/)
    expect(cache).toMatch(/droppedSessionIDs/)
    expect(cache).toMatch(/shellDataKeys\.sessionId\(sessionId, "status"\)/)
    expect(cache).toMatch(/getQueryData<SessionStatus>/)
    expect(cache).toMatch(/promptSessionStatusMeta\(sessionId\)\?\.started/)
    expect(cache).toMatch(/cachedDirectorySession\(directory, sessionId\)/)
    expect(cache).toMatch(/clearPromptSessionStatus\(sessionId\)/)
    expect(listEvents).not.toMatch(/store\.session_status\[/)
    expect(listEvents).not.toMatch(/store\.session_status_meta\[[^\]]+\]\?\.started/)
    expect(listEvents).not.toMatch(/draft\.session_status(?:_meta)?/)
    expect(listEvents).not.toMatch(/function recentlyActive[\s\S]*store\.session\.find/)
    expect(listEvents).not.toMatch(/store\.(?:message|part)/)
    expect(listEvents).not.toMatch(/Object\.(?:keys|values)\(store\.(?:message|part)\)/)
    expect(types).not.toMatch(/session_working\(id: string\): boolean/)
    expect(types).not.toMatch(/export type State/)
    expect(types).not.toMatch(/session_status:\s*\{/)
    expect(directoryCacheManager).not.toMatch(/sessionStatusSnapshot/)
    expect(directoryCacheManager).not.toMatch(/shellDataKeys\.sessionId\([^)]*"status"\)/)
    expect(statusDispatcher).toMatch(/shellDataKeys\.sessionId\(input\.event\.sessionID, "status"\)/)
    expect(statusDispatcher).toMatch(/getQueryData<SessionStatus>/)
    expect(directoryCacheManager).not.toMatch(/setStore\("session_status"/)
    expect(directoryCacheManager).not.toMatch(/session_status:\s*\{\}/)
    expect(types).not.toMatch(/session_diff:/)
    expect(directoryCacheManager).not.toMatch(/session_diff:\s*\{\}/)
    expect(cache).not.toMatch(/store\.session_diff/)
    expect(cache).not.toMatch(/session_status/)
    expect(context).not.toMatch(/session_todo/)
    expect(eventIngress).toMatch(/routeDirectoryEvent\(\{/)
    expect(eventIngress).toMatch(/mark: \(\) => input\.children\.mark\(directory\)/)
    expect(eventIngress).toMatch(/cacheSessions: \(next\) => \{/)
    expect(eventRouter).toMatch(
      /applyDirectoryEventToShellQueries\(\{ event: input\.event, directory: input\.directory \}\)[\s\S]*input\.sinks\.mark\?\.\(\)[\s\S]*applySessionStatusSseEvent\(\{ event: input\.event, directory: input\.directory \}\)[\s\S]*applyDirectorySessionCacheEvent/,
    )
    expect(context).not.toMatch(/applySessionStatusSseEvent\(\{[^}]*setStore/)
    expect(eventIngress).toMatch(
      /applyClaxedoSessionLifecycleEvent[\s\S]*applySessionStatusSseEvent\(\{[\s\S]*type: "session\.idle"/,
    )
    expect(listEvents).not.toMatch(/projectDirectoryEventToShellQueries/)
    expect(listEvents).not.toMatch(/applySessionStatusSseEvent/)
    expect(listEvents).not.toMatch(/observeSessionStatusEvent/)
    expect(listEvents).not.toMatch(/dispatchSessionStatusEvent/)
    expect(listEvents).not.toMatch(/session\.diff/)
    expect(listEvents).not.toMatch(/todo\.updated/)
    expect(listEvents).toMatch(/server\.instance\.disposed/)
    expect(listEvents).not.toMatch(/lsp\.updated/)
    expect(statusDispatcher).toMatch(/applySessionStatusSseEvent/)
    expect(statusDispatcher).toMatch(/observeSessionStatusEvent/)
    expect(statusDispatcher).toMatch(/dispatchSessionStatusEvent/)
    expect(statusDispatcher).not.toMatch(/SetStoreFunction/)
    expect(statusDispatcher).not.toMatch(/\bproduce\b/)
    expect(statusDispatcher).not.toMatch(/applySessionStatusEventToState/)
    expect(statusDispatcher).not.toMatch(/applySessionStatusTimeoutStageToState/)
    expect(statusDispatcher).not.toMatch(/setStore/)
    expect(projector).toMatch(
      /setSessionDiffQueryData\(\{ queryClient, sessionId: props\.sessionID, diff: list\(props\.diff\) \}\)/,
    )
    expect(projector).not.toMatch(/setQueryData\(shellDataKeys\.sessionId\(props\.sessionID, "diff"\)/)
    expect(projector).toMatch(
      /dispatchSessionTodoEvent\(\{[\s\S]*sessionID: props\.sessionID,[\s\S]*todos: props\.todos/,
    )
    expect(projector).not.toMatch(/setSessionTodoQueryData\(\{ queryClient, sessionId: props\.sessionID/)
    expect(projector).not.toMatch(/setQueryData\(shellDataKeys\.sessionId\(props\.sessionID, "todo"\)/)
    expect(projector).toMatch(/dispatchSessionRequestsEvent/)
    expect(projector).not.toMatch(/setSessionRequestsQueryData/)
    expect(projector).not.toMatch(/setQueryData\(\s*shellDataKeys\.sessionId\(sessionID, "requests"\)/)
    expect(projector).not.toMatch(/case "session\.created"/)
    expect(listEvents).toMatch(/case "session\.created"/)
    expect(listEvents).toMatch(/applySessionListEvent/)
    expect(directoryCacheManager).toMatch(
      /cached<SessionCacheValue>\(key, directory, queryKeys\.directory\.sessionCache\)/,
    )
    expect(listEvents).not.toMatch(/setQueryData\(\s*queryKeys\.directory\.sessionCache/)
    expect(listEvents).not.toMatch(/function (?:set|upsert|remove)DirectorySessionCache/)
    expect(types).not.toMatch(/\bmessage:\s*\{/)
    expect(types).not.toMatch(/\bpart:\s*\{/)
    expect(types).not.toMatch(/\bpermission:\s*\{/)
    expect(directoryCacheManager).not.toMatch(/\bmessage:\s*\{/)
    expect(directoryCacheManager).not.toMatch(/\bpart:\s*\{/)
    expect(directoryCacheManager).not.toMatch(/\bpermission:\s*\{/)
    expect(cache).not.toMatch(/store\.message/)
    expect(cache).not.toMatch(/store\.part/)
    expect(cache).not.toMatch(/store\.(?:todo|permission|question)/)
    expect(types).not.toMatch(/\b(?:todo|question):\s*\{/)
    expect(directoryCacheManager).not.toMatch(/\b(?:todo|question):\s*\{/)
    expect(cache).not.toMatch(/\b(?:todo|question):\s*\{/)
    expect(types).not.toMatch(/session_(?:agent|config|usage)/)
    expect(directoryCacheManager).not.toMatch(/session_(?:agent|config|usage)/)
    expect(cache).not.toMatch(/session_(?:agent|config|usage)/)
    expect(types).not.toMatch(/\b(?:mcp_ready|lsp_ready|vcs):/)
    expect(types).not.toMatch(/\b(?:mcp|lsp):\s*[\{\[]/)
    expect(directoryCacheManager).not.toMatch(/\b(?:mcp_ready|lsp_ready|vcs):/)
    expect(directoryCacheManager).not.toMatch(/\b(?:mcp|lsp):\s*[\{\[]/)
    expect(types).not.toMatch(/\bcommand:\s*Command\[\]/)
    expect(directoryCacheManager).not.toMatch(/\bcommand:\s*\[\]/)
    expect(context).not.toMatch(/setStore\("command"/)
    expect(types).not.toMatch(/\bagent:\s*Agent\[\]/)
    expect(directoryCacheManager).not.toMatch(/\bagent:\s*\[\]/)
    expect(context).not.toMatch(/setStore\("agent"/)
    expect(types).not.toMatch(/\bconfig:\s*Config\b/)
    expect(directoryCacheManager).not.toMatch(/\bconfig:\s*\{\}/)
    expect(context).not.toMatch(/input\.setStore\("config"/)
    expect(types).not.toMatch(/\bpath:\s*Path\b/)
    expect(directoryCacheManager).not.toMatch(/\bpath:\s*\{/)
    expect(context).not.toMatch(/input\.setStore\("path"/)
    expect(bootstrap).toMatch(/queryKeys\.directory\.path\(baseUrl, directory\)/)
    expect(types).not.toMatch(/\bprovider_ready:/)
    expect(types).not.toMatch(/\bprovider:\s*NormalizedProviderListResponse\b/)
    expect(directoryCacheManager).not.toMatch(/\bprovider_ready:/)
    expect(directoryCacheManager).not.toMatch(/\bprovider:\s*\{/)
    expect(bootstrap).not.toMatch(/input\.setStore\("provider(?:_ready)?"/)
    // The provider catalog is cached through the shared key builder rather than
    // a bootstrap-local store. The key now also takes a harness (each harness
    // serves a different catalog), so match the call, not its exact arity.
    expect(bootstrap).toMatch(/queryKeys\.controlPlane\.providers\(\s*input\.baseUrl[,)]/)
    expect(types).not.toMatch(/\bproject:\s*string\b/)
    expect(directoryCacheManager).not.toMatch(/\bproject:\s*""/)
    expect(bootstrap).not.toMatch(/input\.setStore\("project"/)
    expect(bootstrap).toMatch(/queryKeys\.directory\.project\(baseUrl, directory\)/)
    expect(types).not.toMatch(/\bprojectMeta:\s*ProjectMeta\b/)
    expect(types).not.toMatch(/\bicon:\s*string\b/)
    expect(directoryCacheManager).not.toMatch(/createStore<State>\(\{[\s\S]{0,180}\bprojectMeta\b/)
    expect(directoryCacheManager).not.toMatch(/createStore<State>\(\{[\s\S]{0,180}\bicon\b/)
    expect(directoryCacheManager).not.toMatch(/setStore\("projectMeta"/)
    expect(directoryCacheManager).not.toMatch(/setStore\("icon"/)
    expect(directoryCacheManager).not.toMatch(
      /createStore|solid-js\/store|Store<State>|SetStoreFunction|DirectoryChildStore/,
    )
    expect(types).not.toMatch(/\bstatus:\s*"loading"\s*\|/)
    expect(directoryCacheManager).not.toMatch(/\bstatus:\s*"loading"/)
    expect(bootstrap).not.toMatch(/input\.setStore\("status"/)
    expect(bootstrap).not.toMatch(/store:\s*Store<State>/)
    expect(bootstrap).not.toMatch(/setStore:\s*SetStoreFunction<State>/)
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
    expect(text).toMatch(/directorySessionCacheQueryOptions/)
    expect(text).toMatch(/sessionInventoryQueryOptions/)
    expect(text).not.toMatch(/sync\.session\.get/)
    expect(text).not.toMatch(/sync\.set\(/)
    expect(text).not.toMatch(/sync\.data\.session/)
    expect(text).not.toMatch(/sync\.data\.session_status/)
    expect(text).not.toMatch(/sync\.data\.(?:permission|question|session_diff)/)
    expect(text).toMatch(/activeTurn=\{sessionController\.activeTurn\}/)
    expect(text).toMatch(/diffFiles=\{diffFiles\}/)
    expect(text).not.toMatch(/extractPromptFromParts\(sync\.data\.part/)
    expect(text).toMatch(/registeredConversationSnapshot/)
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

  test("workspace action surfaces warm session cache instead of child-store readiness", async () => {
    const projectActions = await Bun.file(path.join(root, claxedoProjectActions)).text()
    const workspaceActions = await Bun.file(path.join(root, claxedoWorkspaceActions)).text()
    const workspaceRecovery = await Bun.file(path.join(root, claxedoWorkspaceRecovery)).text()
    const shared = await Bun.file(path.join(root, claxedoActionShared)).text()
    const cache = await Bun.file(path.join(root, directorySessionCache)).text()

    expect(projectActions).toMatch(/ensureDirectorySessionCache/)
    expect(workspaceActions).toMatch(/ensureDirectorySessionCache/)
    expect(workspaceRecovery).toMatch(/ensureDirectorySessionCache/)
    expect(shared).toMatch(/directorySessionCacheActions/)
    expect(shared).not.toMatch(/ensureShellDirectorySessionCache/)
    expect(cache).toMatch(/directorySessionCacheQueryOptions/)
    expect(cache).toMatch(/queryClient\.getQueryData/)
    expect(projectActions).not.toMatch(/child\.status === "loading"/)
    expect(workspaceRecovery).not.toMatch(/child\.status === "loading"/)
    expect(workspaceActions).not.toMatch(/globalSync\.child/)
  })

  test("directory session cache warmers use the shell data boundary", async () => {
    const texts = await Promise.all(
      [appShellState, claxedoSessionActions, claxedoActionShared, layoutContext].map(async (file) =>
        Bun.file(path.join(root, file)).text(),
      ),
    )

    for (const text of texts) {
      expect(text).toMatch(/ensureDirectorySessionCache|useDirectorySessionCacheActions|directorySessionCacheActions/)
      expect(text).not.toContain(
        "if (queryClient.getQueryData(directorySessionCacheQueryOptions({ directory }).queryKey)) return",
      )
    }
  })

  test("forced session cache refreshes use the shell data boundary", async () => {
    const texts = await Promise.all(
      [sessionPage, sessionController, promptSubmit, claxedoSessionActions, directoryScope].map(async (file) =>
        Bun.file(path.join(root, file)).text(),
      ),
    )

    for (const text of texts) {
      expect(text).toMatch(/refreshDirectorySessionCache|useDirectorySessionCacheActions|directorySessionCacheActions/)
      expect(text).not.toMatch(/globalSync\.refreshDirectory\((?:directory|dir|workspaceDir|sessionDirectory|cwd)/)
    }
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

    expect(text).toMatch(/registeredConversationSnapshot/)
    expect(text).toMatch(/const sessionConversation = createMemo/)
    expect(text).toMatch(
      /const sessionMessages = createMemo\(\(\) => sessionConversation\(\)\?\.messages \?\? emptyMessages\)/,
    )
    expect(text).toMatch(
      /const getMsgParts = \(msgId: string\) => sessionConversation\(\)\?\.parts\[msgId\] \?\? emptyParts/,
    )
    expect(text).toMatch(/const parentConversation = createMemo/)
    expect(text).toMatch(/agentListQuery/)
    // No configQuery: the timeline's only config read gated the session-share
    // menu, which Claxedo does not ship. `sync.data.config` stays banned below.
    expect(text).toMatch(/directorySessionCacheQueryOptions/)
    expect(text).toMatch(/sessionSync\?\.syncSession\?\.\(id\)/)
    expect(text).not.toMatch(/\buseSync\b/)
    expect(text).not.toMatch(/sync\.session\.get/)
    expect(text).not.toMatch(/sync\.session\.sync/)
    expect(text).not.toMatch(/sync\.set\(/)
    expect(text).not.toMatch(/sync\.data\.(?:message|part)/)
    expect(text).not.toMatch(/sync\.data\.session/)
    expect(text).not.toMatch(/sync\.data\.session_status/)
    expect(text).not.toMatch(/sync\.data\.(?:agent|config)/)
    expect(text).toMatch(/status:\s*\(\) => SessionStatus/)
    expect(text).not.toMatch(/\bSessionContextUsage\b|session-context-usage/)
  })

  test("SessionController exposes visible messages from the registered chat projection", async () => {
    const text = await Bun.file(path.join(root, sessionController)).text()

    expect(text).toMatch(/registeredConversationSnapshot/)
    expect(text).toMatch(/hydrateConversationPage/)
    expect(text).toMatch(/sessionStatusQueryOptions/)
    expect(text).toMatch(/dispatchSessionStatusEvent/)
    expect(text).toMatch(/sessionRequestsQueryOptions/)
    expect(text).toMatch(/dispatchSessionRequestsEvent/)
    expect(text).toMatch(/sessionTodoQueryOptions/)
    expect(text).toMatch(/sessionDiffQueryOptions/)
    expect(text).toMatch(/directorySessionCacheQueryOptions/)
    expect(text).toMatch(/const snapshot = registeredConversationSnapshot\(sessionID\)/)
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

    // Wave 2 extracted the history-meta signal into createHistoryMetaState();
    // the controller wires that signal-backed state, and the extracted module
    // still backs it with createSignal<HistoryMeta> (never a createStore mirror).
    expect(text).toMatch(/createHistoryMetaState\(\)/)
    expect(historyPagination).toMatch(/createSignal<HistoryMeta>/)
    expect(historyPagination).not.toMatch(/createStore/)
    expect(text).toMatch(/function sessionCapabilitiesKey\(sessionID: string\)/)
    expect(text).toMatch(/shellDataKeys\.sessionId\(sessionID, "transport-capabilities"\)/)
    expect(text).toMatch(/queryClient\.fetchQuery\(\{[\s\S]*queryKey: key,[\s\S]*fetchSessionCapabilitiesByTransport/)
    expect(text).toMatch(/useDirectorySessionCacheActions/)
    expect(text).toMatch(/useSessionInventoryActions/)
    expect(text).not.toMatch(/useGlobalSync/)
    expect(text).not.toMatch(/createStore\(/)
    expect(text).not.toMatch(/const \[compat, setCompat\]/)
    expect(text).not.toMatch(/const \[historyMeta, setHistoryMeta\] = createStore/)
  })

  test("SessionComposerState reads todo, request, and status state from shell session queries", async () => {
    const text = await Bun.file(path.join(root, sessionComposerState)).text()
    const index = await Bun.file(path.join(root, sessionComposer)).text()
    const region = await Bun.file(path.join(root, sessionComposerRegion)).text()
    const sessionPageText = await Bun.file(path.join(root, sessionPage)).text()

    expect(await Bun.file(path.join(root, "overrides/features/session/ui/composer/index.ts")).exists()).toBe(false)
    expect(
      await Bun.file(path.join(root, "overrides/features/session/ui/composer/session-composer-state.ts")).exists(),
    ).toBe(false)
    expect(await Bun.file(path.join(root, sessionComposer)).exists()).toBe(true)
    expect(await Bun.file(path.join(root, sessionComposerRegion)).exists()).toBe(true)
    expect(await Bun.file(path.join(root, sessionComposerState)).exists()).toBe(true)
    expect(index).toMatch(/\.\/session-composer-region/)
    expect(index).toMatch(/\.\/session-composer-state/)
    // Region imports the SessionComposerState type from its colocated state
    // module (a relative sibling import after WP-B6 alignment), never
    // re-declaring it and never reaching for the @/ package alias.
    expect(region).toMatch(/from "\.\/session-composer-state"/)
    expect(region).not.toMatch(/@\/pages\/session\/composer\/session-composer-state/)
    // session-screen imports the first-party composer from its canonical
    // features/session/ui home, never through the retired @/pages alias.
    expect(sessionPageText).toMatch(/@\/features\/session\/ui\/composer/)
    expect(sessionPageText).not.toMatch(/@\/pages\/session\/composer/)
    expect(text).toMatch(/useSessionParams/)
    expect(text).toMatch(/@\/features\/session\/providers\/session-params/)
    expect(text).not.toMatch(/@\/claxedo-ui\/context\/session-params/)
    expect(text).toMatch(/@\/features\/session\/data\/sync\/queries/)
    expect(text).not.toMatch(/@\/shell\/data\/queries/)
    expect(text).toMatch(/directorySessionCacheQueryOptions/)
    expect(text).toMatch(/sessionStatusQueryOptions/)
    expect(text).toMatch(/sessionTodoQueryOptions/)
    expect(text).toMatch(/sessionRequestsQueryOptions/)
    expect(text).toMatch(/dispatchSessionTodoEvent/)
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
    expect(text).toMatch(/registeredConversationSnapshot\(sessionId\(\)\)/)
    expect(text).toMatch(/getSessionContextMetrics\(messages\(\), Array\.from\(providers\.all\(\)\.values\(\)\)\)/)
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

  test("upstream titlebar tab enrichment reads session rows from directory cache", async () => {
    const text = await Bun.file(path.join(root, "app/workbench/titlebar/titlebar.tsx")).text()

    expect(text).toMatch(/useQuery\(\(\) => directorySessionCacheQuery\(tab\.dir\)\)/)
    expect(text).toMatch(/sessionsQuery\.data\?\.session\.find\(\(session\) => session\.id === tab\.sessionId\)/)
    expect(text).not.toMatch(/useGlobalSync/)
    expect(text).not.toMatch(/createDirSyncContext/)
    expect(text).not.toMatch(/sync\.session\.get/)
  })

  test("upstream new-session empty views read project and branch inputs from query caches", async () => {
    const legacy = await Bun.file(path.join(root, "features/session/ui/components/session-new-view.tsx")).text()
    const design = await Bun.file(path.join(root, "features/session/ui/components/session-new-design-view.tsx")).text()

    expect(legacy).toMatch(/useQuery\(\(\) => queryOptions\.projects\(\)\)/)
    expect(legacy).toMatch(/queryClient\.fetchQuery\(workspaceVcsQuery\(\{/)
    expect(legacy).toMatch(/vcsInfo\(\)\?\.branch/)
    expect(legacy).not.toMatch(/\buseSync\b/)
    expect(legacy).not.toMatch(/sync\.project/)
    expect(legacy).not.toMatch(/sync\.data\.vcs/)

    expect(design).toMatch(/useQuery\(\(\) => queryOptions\.projects\(\)\)/)
    expect(design).toMatch(/inventoryProjects\(\)\.find/)
    expect(design).toMatch(/layout\.projects\.list\(\)/)
    expect(design).not.toMatch(/\buseSync\b/)
    expect(design).not.toMatch(/useGlobalSync/)
    expect(design).not.toMatch(/globalSync\.data\.project/)
    expect(design).not.toMatch(/sync\.data\.vcs/)
  })

  test("upstream MCP status surfaces read MCP, LSP, and plugin state from query caches", async () => {
    const claxedoDialog = await Bun.file(path.join(root, "features/session/ui/dialogs/select-mcp.tsx")).text()
    const claxedoLogic = await Bun.file(path.join(root, "features/extensions/marketplace/api.ts")).text()
    const claxedoStatus = await Bun.file(path.join(root, "app/connection/status-popover.tsx")).text()
    const claxedoSessionHeader = await Bun.file(path.join(root, sessionHeader)).text()
    const backend = await Bun.file(path.join(root, "platform/runtime/http-backend.ts")).text()

    expect(await Bun.file(path.join(root, "overrides/components/dialog-select-mcp-logic.ts")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "overrides/components/dialog-select-mcp.tsx")).exists()).toBe(false)
    expect(await Bun.file(path.join(root, "overrides/app/connection/status-popover.tsx")).exists()).toBe(false)
    // The select-mcp dialog (session feature) reaches the marketplace API
    // through session app-ports, whose types are pinned to the canonical
    // @/features/extensions/marketplace/api owner — same-owner invariant.
    const sessionPortsText = await Bun.file(path.join(root, "features/session/app-ports.ts")).text()
    expect(claxedoDialog).toMatch(/loadMcpDialogData/)
    expect(claxedoDialog).toMatch(/@\/features\/session\/app-ports/)
    expect(sessionPortsText).toMatch(/import type \* as Marketplace from "@\/features\/extensions\/marketplace\/api"/)
    expect(claxedoLogic).toMatch(/function mcpExtensionUrl/)
    expect(claxedoLogic).not.toMatch(/RuntimeGateway\./)
    expect(claxedoStatus).toMatch(/return null/)
    // SessionHeader mounts StatusPopover through session app-ports, pinned to
    // the app-owned @/app/connection/status-popover — never a relative copy.
    expect(claxedoSessionHeader).toMatch(/StatusPopover/)
    expect(claxedoSessionHeader).toMatch(/@\/features\/session\/app-ports/)
    expect(sessionPortsText).toMatch(/import type \* as StatusPopoverModule from "@\/app\/connection\/status-popover"/)
    expect(claxedoSessionHeader).not.toMatch(/\.\.\/status-popover/)
    expect(backend).toMatch(/getMcpStatus: async/)
    expect(backend).toMatch(/getLspStatus: async/)
    expect(claxedoDialog).not.toMatch(/directoryMcpQuery|directoryLspQuery/)
    expect(claxedoStatus).not.toMatch(/directoryMcpQuery|directoryLspQuery/)
  })

  test("legacy SyncProvider bridge is deleted after DataProvider cutover", async () => {
    const directoryScopeText = await Bun.file(path.join(root, directoryScope)).text()
    const controllerText = await Bun.file(path.join(root, sessionController)).text()

    expect(await Bun.file(path.join(root, syncContext)).exists()).toBe(false)
    expect(directoryScopeText).toMatch(/DirectoryDataProvider/)
    expect(directoryScopeText).toMatch(/fetchSessionMessagesByTransport/)
    expect(directoryScopeText).toMatch(/hydrateConversationPage/)
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

  test("DialogSelectFile receives session identity from its caller", async () => {
    const text = await Bun.file(path.join(root, dialogSelectFile)).text()
    const commands = await Bun.file(path.join(root, sessionCommandsHook)).text()
    const reviewWorkspace = await Bun.file(path.join(root, "app/workbench/review/review-workspace.tsx")).text()

    expect(text).not.toMatch(/\buseParams\b/)
    expect(text).not.toMatch(/\bdecode64\b/)
    expect(text).toMatch(/directory:\s*string/)
    expect(text).toMatch(/sessionId\?:\s*string/)
    expect(text).toMatch(/queryOptions\.path\(null\)/)
    expect(text).not.toMatch(/globalSync\.data\.path\.home/)
    expect(commands).toMatch(
      /<DialogSelectFile[\s\S]*directory=\{args\.directory\(\)\}[\s\S]*sessionId=\{args\.sessionId\(\)\}/,
    )
    expect(commands).toMatch(/directorySessionCacheQueryOptions/)
    expect(commands).not.toMatch(/\buseSync\b/)
    expect(commands).not.toMatch(/sync\.session\.get/)
    expect(reviewWorkspace).toMatch(
      /<DialogSelectFile[\s\S]*directory=\{props\.directory\}[\s\S]*sessionId=\{props\.sessionId\}/,
    )
  })

  test("PromptInput resolves session identity without router params", async () => {
    const text = await Bun.file(path.join(root, promptInput)).text()
    const submit = await Bun.file(path.join(root, promptSubmit)).text()
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
    expect(text).toMatch(/agentListQuery/)
    expect(text).toMatch(/directorySessionCacheQueryOptions/)
    expect(text).not.toMatch(/sync\.session\.get/)
    expect(text).not.toMatch(/sync\.data\.(?:agent|permission|question|session_diff)/)
    expect(props).toMatch(/activeTurn\?:\s*\(\) => boolean/)
    expect(props).toMatch(/diffFiles\?:\s*\(\) => readonly string\[\]/)
    expect(text).toMatch(/promptSessionStatusStage/)
    expect(text).toMatch(/registeredConversationHasUserMessage/)
    expect(toolbar).toMatch(/promptModelFallbackState/)
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
    expect(submit).toMatch(/addRegisteredConversationMessage/)
    expect(submit).toMatch(/removeRegisteredConversationMessage/)
    expect(submit).not.toMatch(/setQueryData\(shellDataKeys\.sessionId\(sessionID, "requests"\)/)
    expect(submit).toMatch(/surfaceId\?:\s*Accessor<string \| undefined>/)
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

  test("PromptProvider receives persistence identity from explicit provider props", async () => {
    const text = await Bun.file(path.join(root, promptContext)).text()
    const cacheModule = await Bun.file(path.join(root, liveResourceCache)).text()
    const directoryLayout = await Bun.file(path.join(root, "app/routes/directory-layout.tsx")).text()
    const directoryScopeText = await Bun.file(path.join(root, directoryScope)).text()
    const reviewWorkspace = await Bun.file(path.join(root, "app/workbench/review/review-workspace.tsx")).text()

    expect(await Bun.file(path.join(root, "overrides/features/session/providers/prompt.tsx")).exists()).toBe(false)
    expect(text).not.toMatch(/@solidjs\/router/)
    expect(text).not.toMatch(/\buseParams\b/)
    expect(text).not.toMatch(/\buseSessionParams\b/)
    expect(text).not.toMatch(/not in split mode/)
    expect(text).toMatch(
      /type PromptProviderProps = \{[\s\S]*directory\?: Accessor<string> \| string[\s\S]*sessionId\?: Accessor<string \| undefined> \| string/,
    )
    // WP-B6: the bounded prompt-session cache (Map + entry struct + eviction)
    // was extracted into the shared live-resource-cache module. prompt.tsx wires
    // the factory around createRoot(createPromptSession) and must not re-inline
    // the Map/entry it used to own.
    //
    // The factory is the REF-COUNTED LRU, not the plain LRU: eviction disposes
    // the scope's reactive root, and `session()` is memoized on the provider's
    // props, so a plain LRU can dispose a scope a mounted composer is still
    // subscribed to (same object handed back, memos unsubscribed — the draft
    // silently stops updating). The pin on the currently-resolved scope is what
    // rules that out, so `acquire` and its paired release are both pinned here.
    expect(text).toMatch(
      /import \{ createRefCountedLruResourceCache \} from "@\/platform\/sync\/live-resource-cache"/,
    )
    expect(text).not.toMatch(/createLruResourceCache</)
    expect(text).toMatch(
      /const promptCache = createRefCountedLruResourceCache<PromptSession>\(MAX_PROMPT_SESSIONS\)/,
    )
    expect(text).toMatch(
      /promptCache\.acquire\(key, \(\) =>[\s\S]*createRoot\([\s\S]*createPromptSession\(server\.url, dir, id\)/,
    )
    // Every acquire is paired. The mounted scope releases through the memo's own
    // onCleanup (which runs both before a recompute and on teardown); a scoped
    // set/reset borrows its target and releases in a `finally` so a throwing
    // writer cannot leak a pin — a leaked pin makes the entry immortal, which is
    // a worse bug than the eviction the pin exists to prevent.
    expect(text).toMatch(/onCleanup\(handle\.release\)/)
    expect(text).toMatch(/try \{[\s\S]*return use\(handle\.value\)[\s\S]*\} finally \{[\s\S]*handle\.release\(\)/)
    expect(text).not.toMatch(/new Map<string, PromptCacheEntry>/)
    expect(text).not.toMatch(/export const promptCache/)
    // Same invariant, new home: the disposable-resource struct, the
    // dispose-on-eviction rule, and the skip-the-pinned rule live in the
    // extracted module.
    expect(cacheModule).toMatch(
      /export type DisposableResource<T> = \{[\s\S]*value: T[\s\S]*dispose: \(\) => void[\s\S]*\}/,
    )
    expect(cacheModule).toMatch(/export function createRefCountedLruResourceCache<T>\(max: number\)/)
    expect(cacheModule).toMatch(/if \(entry\.refs > 0\) continue/)
    // Eviction is the ONLY place dispose runs, and it runs at most once.
    expect(cacheModule).toMatch(/const disposeOnce = \(entry: Entry\) => \{[\s\S]*entry\.disposed = true[\s\S]*entry\.dispose\(\)/)
    expect(cacheModule).toMatch(/cache\.delete\(key\)\n\s*disposeOnce\(entry\)/)
    // The unpinned LRU that used to live here is DELETED, not merely unused: it
    // disposed on cap pressure with no idea who was still reading, which is
    // never a safe rule for the disposable roots this module caches. Nothing may
    // reintroduce it — not the factory, not its `load` entry point.
    expect(cacheModule).not.toMatch(/createLruResourceCache/)
    expect(cacheModule).not.toMatch(/\bload\b/)
    // Rubric C4: directory-layout is a pure pass-through; PromptProvider
    // mounts only through Workbench's DirectoryScope (per pane) and the
    // review workspace, never through the route subtree.
    expect(directoryLayout).not.toMatch(/<PromptProvider/)
    expect(directoryScopeText).toMatch(/<PromptProvider directory=\{props\.directory\} sessionId=\{props\.sessionId\}>/)
    expect(reviewWorkspace).toMatch(/<PromptProvider directory=\{props\.directory\} sessionId=\{props\.sessionId\}>/)
  })

  test("TerminalProvider caches only live terminal roots behind release handles", async () => {
    const text = await Bun.file(path.join(root, terminalContext)).text()
    const cacheModule = await Bun.file(path.join(root, liveResourceCache)).text()

    // WP-B6: the ref-counted shared-terminal cache (Map + entry struct + refs
    // arithmetic + prune) moved into the shared live-resource-cache module.
    // terminal.tsx now acquires through the ref-counted factory wrapping
    // createRoot(createTerminalSession); the per-provider release-handle map
    // (TerminalCacheEntry) stays local and must not re-inline the shared Map.
    expect(text).toMatch(/import \{ createRefCountedResourceCache \} from "@\/platform\/sync\/live-resource-cache"/)
    expect(text).toMatch(
      /const sharedTerminalCache = createRefCountedResourceCache<TerminalSession>\(MAX_TERMINAL_SESSIONS\)/,
    )
    expect(text).toMatch(
      /sharedTerminalCache\.acquire\(key, \(\) =>[\s\S]*createRoot\(\(dispose\) => \(\{[\s\S]*createTerminalSession\(sdk, dir, options\)/,
    )
    expect(text).not.toMatch(/new Map<string, SharedTerminalCacheEntry>/)
    expect(text).toMatch(/const cache = new Map<string, TerminalCacheEntry>\(\)/)
    expect(text).toMatch(/entry\.release\(\)/)
    expect(text).not.toMatch(/export const sharedTerminalCache/)
    // Same invariant, new home: ref-count decrement, dispose-once-after-last-
    // release, and prune-unreferenced-only now live in the extracted module.
    expect(cacheModule).toMatch(/export function createRefCountedResourceCache<T>\(max: number\)/)
    expect(cacheModule).toMatch(/entry\.refs -= 1/)
    expect(cacheModule).toMatch(/if \(entry\.refs > 0\) return/)
    expect(cacheModule).toMatch(/entry\.dispose\(\)/)
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
    // app/entry/index.tsx re-exports the first-party Terminal directly; the pane
    // consumers now mount it through the first-party RoleGuardedTerminal
    // wrapper (role-gated terminal). Either path resolves to the first-party
    // @/features/terminal/ui/terminal, never an override.
    expect(await Bun.file(path.join(root, "app/entry/index.tsx")).text()).toMatch(/@\/features\/terminal\/ui\/terminal/)
    expect(await Bun.file(path.join(root, "features/terminal/ui/content/terminal-content.tsx")).text()).toMatch(
      /role-guarded-terminal/,
    )
    const processPanel = await Bun.file(
      path.join(root, "features/processes/ui/workspace-panel/process-pane-panel.tsx"),
    ).text()
    const reviewWorkspace = await Bun.file(path.join(root, "app/workbench/review/review-workspace.tsx")).text()
    expect(processPanel).toMatch(/renderTerminal\?:/)
    expect(processPanel).not.toMatch(/role-guarded-terminal/)
    expect(reviewWorkspace).toMatch(/RoleGuardedTerminal/)
    expect(reviewWorkspace).toMatch(/renderTerminal=/)
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

  test("SessionHeader reads tint inputs without the global-sync message mirror", async () => {
    const text = await Bun.file(path.join(root, sessionHeader)).text()

    expect(
      await Bun.file(path.join(root, "overrides/features/session/ui/components/session-header.tsx")).exists(),
    ).toBe(false)
    expect(text).toMatch(/registeredConversationSnapshot/)
    expect(text).toMatch(/queryOptions\.agents/)
    expect(text).not.toMatch(/\buseSync\b/)
    expect(text).not.toMatch(/sync\.data\.message/)
    expect(text).not.toMatch(/sync\.data\.part/)
    expect(text).not.toMatch(/sync\.data\.agent/)
  })

  test("SessionHeader bounds titlebar open-path loading state", async () => {
    const text = await Bun.file(path.join(root, sessionHeader)).text()

    expect(
      await Bun.file(path.join(root, "overrides/features/session/ui/components/session-header.tsx")).exists(),
    ).toBe(false)
    expect(text).toMatch(/OPEN_PATH_REQUEST_TIMEOUT_MS = 10_000/)
    expect(text).toMatch(/let openRequestID = 0/)
    expect(text).toMatch(/armOpenRequestTimeout\(requestID\)/)
    expect(text).toMatch(/clearOpenRequest\(requestID\)/)
    expect(text).toMatch(/onCleanup\(\(\) => \{[\s\S]*clearTimeout\(openRequestTimeout\)/)
    expect(text).not.toMatch(/\.finally\(\(\) => \{[\s\S]{0,120}setOpenRequest\("app", undefined\)[\s\S]{0,40}\}\)/)
  })

  test("upstream SessionHeader reads tint inputs without the global-sync message mirror", async () => {
    const text = await Bun.file(path.join(root, sessionHeader)).text()

    expect(text).toMatch(/registeredConversationSnapshot/)
    expect(text).toMatch(/queryOptions\.agents\(dir \|\| "__claxedo_missing_directory__"\)/)
    expect(text).toMatch(/messageAgentColor/)
    expect(text).not.toMatch(/\buseSync\b/)
    expect(text).not.toMatch(/sync\.data\.message/)
    expect(text).not.toMatch(/sync\.data\.part/)
    expect(text).not.toMatch(/sync\.data\.agent/)
  })

  test("upstream SessionHeader bounds titlebar open-path loading state", async () => {
    const text = await Bun.file(path.join(root, sessionHeader)).text()

    expect(text).toMatch(/OPEN_PATH_REQUEST_TIMEOUT_MS = 10_000/)
    expect(text).toMatch(/let openRequestID = 0/)
    expect(text).toMatch(/armOpenRequestTimeout\(requestID\)/)
    expect(text).toMatch(/clearOpenRequest\(requestID\)/)
    expect(text).not.toMatch(/\.finally\(\(\) => \{[\s\S]{0,120}setOpenRequest\("app", undefined\)[\s\S]{0,40}\}\)/)
  })

  test("ReviewTab keeps VCS payloads query-owned without mount-time status fetches", async () => {
    const text = await Bun.file(path.join(root, reviewTab)).text()
    const cache = await Bun.file(path.join(root, "features/review/ui/review-vcs-cache.ts")).text()

    expect(text).toMatch(/cachedReviewVcsDiff/)
    expect(text).toMatch(/cachedReviewVcsFile/)
    expect(text).toMatch(/cachedReviewVcsRefs/)
    expect(text).toMatch(/cachedReviewVcsTargets/)
    expect(text).toMatch(/initialReviewOpenDiffs/)
    expect(text).toMatch(/onDiffContentRequired/)
    expect(text).toMatch(/afterVisibleWork/)
    expect(text).toMatch(/evt\.details\.type === "session\.status"/)
    expect(text).not.toMatch(/sessionStatusQueryOptions/)
    expect(text).not.toMatch(/initialReviewContentPrefetchFiles/)
    expect(text).toMatch(/data-review-diff-style/)
    expect(text).toMatch(/event\.key\.toLowerCase\(\) !== "d"/)
    expect(cache).toMatch(/"review-vcs-diff"/)
    expect(cache).toMatch(/"review-vcs-file"/)
    expect(cache).toMatch(/"review-vcs-refs"/)
    expect(cache).toMatch(/"review-vcs-targets"/)
    expect(text).not.toMatch(/vcsDiffCache = new Map/)
    expect(text).not.toMatch(/vcsDiffInflight = new Map/)
    expect(text).not.toMatch(/vcsFileCache = new Map/)
    expect(text).not.toMatch(/vcsFileInflight = new Map/)
    expect(text).not.toMatch(/\buseSync\b/)
    expect(text).not.toMatch(/sync\.data\.session_status/)
  })

  test("workspace changed-file navigator exposes stable row selectors for browser performance", async () => {
    const navigator = await Bun.file(path.join(root, "app/workbench/workspace-panel/files-navigator.tsx")).text()
    const fileTree = await Bun.file(path.join(root, "app/workbench/controls/file-tree.tsx")).text()

    expect(navigator).toMatch(/data-testid="workspace-files-navigator"/)
    expect(navigator).toMatch(/data-mode=\{props\.mode\}/)
    expect(navigator).toMatch(/data-file-tree-shell-ready=\{fileTreeShellReady\(\) \? "true" : undefined\}/)
    expect(navigator).toMatch(/data-file-tree-data-ready=\{fileTreeDataReady\(\) \? "true" : undefined\}/)
    expect(navigator).toMatch(/data-testid="workspace-changed-file-list"/)
    expect(navigator).toMatch(/props\.mode === "changes" \? \(/)
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

    expect(text).toMatch(/sessionListQueryOptions/)
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
    expect(text).toMatch(/visibleSessionRows\(\)\.flatMap/)
    expect(text).toMatch(/deriveTerminalSurfaceRows/)
    expect(text).toMatch(/function sessionNavigationRefForRow\(session: Row\)/)
    expect(text).toMatch(/sessionNavigationRefForRow\(session\)/)
    expect(text).toMatch(/sessionInventoryQueryOptions/)
    expect(text).toMatch(/dispatchSessionStatusEvent/)
    expect(text).toMatch(/dispatchSessionRequestsEvent/)
    expect(sessionStatusDispatcher).toMatch(/setSessionStatusQueryData as writeSessionStatusQueryData/)
    expect(sessionStatusDispatcher).toMatch(/setSessionRequestsQueryData as writeSessionRequestsQueryData/)
    expect(text).toMatch(/client\.session\.status\(\)/)
    expect(text).toMatch(/client\.permission\.list\(\)/)
    expect(text).toMatch(/client\.question\.list\(\)/)
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
    // Sidebar prefetch is data-only: it warms the message cache, it never mounts
    // a surface or creates a tab (no preload contents).
    expect(text).not.toMatch(/preload/)
    expect(text).toMatch(/sameWorkspaceSessionPrefetchIds[\s\S]{0,400}prefetchSidebarSessionMessages/)
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
    expect(headerSurfaces).toMatch(/sessionStatusQueryOptions/)
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
    expect(provider).toMatch(/function sameWorkbenchState/)
    expect(provider).toMatch(/if \(sameWorkbenchState\(state\.workbench, next\)\) return/)
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
    expect(text).toMatch(/shellDataKeys\.sessionId\(sessionID, "requests"\)/)
    expect(text).toMatch(/queryClient\.getQueryState\(shellDataKeys\.sessionId\(sessionID, "requests"\)\)/)
    expect(text).not.toMatch(/useGlobalSync/)
    expect(text).not.toMatch(/globalSync\.child/)
    expect(text).not.toMatch(/sessionStore\.session/)
    expect(text).not.toMatch(/store\.permission/)
    expect(text).not.toMatch(/sessionStore\.permission/)
    expect(text).not.toMatch(/sessionStore\.agent/)
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

  test("upstream permission auto-respond checks session lineage from directory cache", async () => {
    const text = await Bun.file(path.join(root, "features/session/providers/permission.tsx")).text()
    const autoResponseCache = await Bun.file(
      path.join(root, "features/session/providers/permission-auto-response-cache.ts"),
    ).text()
    const configHelper = await Bun.file(path.join(root, "platform/query/directory-config-cache.ts")).text()

    expect(configHelper).toMatch(/queryKeys\.directory\.config\(baseUrl, directory\)/)
    // as-any: regex asserts upstream text still contains this compatibility cast.
    expect(configHelper).toMatch(/queryFn: async \(\) => undefined as unknown as Config/)
    expect(autoResponseCache).toMatch(/"permission-auto-respond"/)
    expect(autoResponseCache).toMatch(/permissionAutoRespondedQueryKey/)
    expect(autoResponseCache).toMatch(/permissionAutoAcceptVersionQueryKey/)
    expect(text).toMatch(/useQuery\(\(\) => directoryConfigQuery\(globalSDK\.url, directory\(\) \?\? ""\)\)/)
    expect(text).toMatch(/const permissionConfig = createMemo\(\(\) => configQuery\.data\?\.permission\)/)
    expect(text).toMatch(/hasPermissionPromptRules\(permissionConfig\(\)\)/)
    expect(text).toMatch(/const perm = permissionConfig\(\)/)
    expect(text).toMatch(/directoryConfig\(globalSDK\.url, directory\)\?\.permission/)
    expect(text).toMatch(/const session = directory \? directorySessions\(directory\) : \[\]/)
    expect(text).toMatch(/autoRespondsPermission\(store\.autoAccept, session, \{ sessionID \}, directory\)/)
    expect(text).toMatch(/autoRespondsPermission\(store\.autoAccept, session, permission, directory\)/)
    expect(text).toMatch(/markPermissionAutoResponded\(permission\.id\)/)
    expect(text).toMatch(/permissionAutoAcceptVersion\(sessionID, directory\)/)
    expect(text).not.toMatch(/const responded = new Map/)
    expect(text).not.toMatch(/const enableVersion = new Map/)
    expect(text).not.toMatch(/useGlobalSync/)
    expect(text).not.toMatch(/globalSync\.child/)
    expect(text).not.toMatch(/childStore\.config/)
    expect(text).not.toMatch(/store\.config\.permission/)
    expect(text).not.toMatch(/globalSync\.child\(directory, \{ bootstrap: false \}\)\[0\]\.session/)
  })

  test("upstream notification lookup reads directory session cache before network fallback", async () => {
    const text = await Bun.file(path.join(root, notificationContext)).text()

    expect(text).toMatch(/directorySessions\(input\.directory\)\.find\(\(item\) => item\.id === input\.sessionID\)/)
    expect(text).toMatch(/input\.getSession\(\{[\s\S]*directory: input\.directory,[\s\S]*sessionID: input\.sessionID/)
    expect(text).toMatch(/upsertDirectorySession\(input\.directory, session\)/)
    expect(text).toMatch(/getSession:\s*\(parameters\) => globalSDK\.client\.session\.get\(parameters\)/)
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

    expect(text).toMatch(/directorySessionCacheQueryOptions\(\{[\s\S]*directory: dir\(\)/)
    expect(text).toMatch(/directorySessions\(\)\.find\(\(session\) => session\.id === sessionID\)/)
    expect(text).toMatch(/registeredConversationSnapshot\(sessionID\(\)\)/)
    expect(text).toMatch(/SessionConversationOwner/)
    expect(text).toMatch(/sessionController\.status/)
    expect(text).toMatch(/sessionController\.diffsReady\(\)/)
    expect(text).toMatch(/updateDirectorySession\(dir\(\), sessionID/)
    expect(controller).toMatch(/sessionTodoQueryOptions\(\{/)
    expect(controller).toMatch(/sessionDiffQueryOptions\(\{/)
    expect(controller).toMatch(/shellDataKeys\.sessionId\(sessionID, "todo"\)/)
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
    const globalSync = await Bun.file(path.join(root, globalSyncContext)).text()
    const shellQuery = await Bun.file(path.join(root, "features/session/data/query/shell.ts")).text()
    const workspaceResolver = await Bun.file(path.join(root, "features/session/composer/workspace-resolver.ts")).text()

    expect(text).toMatch(/agentListQuery\(/)
    expect(text).toMatch(/commandListQuery\(/)
    expect(text).toMatch(
      /directorySessionCacheQueryOptions\(\{[\s\S]*directory: resolvedSessionDirectory\(\) \?\? sdk\.directory/,
    )
    expect(text).toMatch(/directorySessionCacheQuery\.data\?\.session\.find\(\(session\) => session\.id === sid\)/)
    expect(text).toMatch(/const projectCatalog = \(\) => \(projectsQuery\.data \?\? \[\]\) as ProjectCatalogItem\[\]/)
    expect(text).toMatch(/resolveSubmitSessionDirectory\(\{/)
    expect(workspaceResolver).toMatch(/project\.sandboxes\?\.some/)
    expect(text).toMatch(/<PromptInputFrame[\s\S]*agentNames=\{toolbarState\.agentNames\}/)
    expect(text).toMatch(/registeredConversationHasUserMessage\(sessionID\)/)
    expect(text).not.toMatch(/\buseSync\b/)
    expect(text).not.toMatch(/sync\.session\.get/)
    expect(text).not.toMatch(/sync\.data\.command/)
    expect(text).not.toMatch(/sync\.project/)
    expect(text).not.toMatch(/sync\.data\.session_diff\[sessionID\]/)
    expect(text).not.toMatch(/sync\.data\.agent/)
    expect(text).not.toMatch(/sync\.data\.message\[sessionID\]/)
    expect(submit).toMatch(/resolveSubmitMode/)
    expect(submit).toMatch(/dispatchCommandPromptSubmit/)
    expect(submit).toMatch(/commandListQuery\(/)
    expect(submit).toMatch(/queryClient\s*\.\s*fetchQuery\(/)
    expect(shellQuery).toMatch(/export function commandListQuery/)
    expect(submit).toMatch(
      /addRegisteredConversationMessage\(\{[\s\S]*message: item\.message,[\s\S]*parts: item\.parts/,
    )
    expect(submit).toMatch(/removeRegisteredConversationMessage\(\{[\s\S]*messageID/)
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

    expect(text).toMatch(/registeredConversationSnapshot\(sessionId\(\)\)/)
    expect(text).toMatch(/forkableMessages\(conversation\(\)/)
    expect(text).toMatch(/conversation\(\)\.parts\[item\.id\]/)
    expect(text).not.toMatch(/\buseSync\b/)
    expect(text).not.toMatch(/sync\.data\.message/)
    expect(text).not.toMatch(/sync\.data\.part/)
  })

  test("upstream SessionContextTab reads conversation data from registered chat projection", async () => {
    const text = await Bun.file(path.join(root, "features/session/ui/components/session-context-tab.tsx")).text()

    expect(text).toMatch(/registeredConversationSnapshot\(sessionId\(\)\)/)
    expect(text).toMatch(/directorySessionCacheQuery\.data\?\.session\.find\(\(session\) => session\.id === id\)/)
    expect(text).toMatch(/conversation\(\)\.messages as Message\[\]/)
    expect(text).toMatch(/conversation\(\)\.parts as Record<string, Part\[\] \| undefined>/)
    expect(text).toMatch(/conversation\(\)\.parts\[id\]/)
    expect(text).not.toMatch(/\buseSync\b/)
    expect(text).not.toMatch(/sync\.session\.get/)
    expect(text).not.toMatch(/sync\.data\.message/)
    expect(text).not.toMatch(/sync\.data\.part/)
  })

  test("upstream session commands read conversation data from registered chat projection", async () => {
    const text = await Bun.file(path.join(root, "features/session/ui/use-session-commands.tsx")).text()

    expect(text).toMatch(/registeredConversationSnapshot\(args\.sessionId\(\)\)/)
    expect(text).toMatch(/registeredConversationUserMessages\(args\.sessionId\(\)\) as UserMessage\[\]/)
    expect(text).toMatch(/conversation\(\)\.parts\[message\.id\]/)
    expect(text).toMatch(/directorySessionCacheQueryOptions\(\{ directory: args\.directory\(\) \}\)\.queryKey/)
    // The hook's only config read was the share-command gate, and Claxedo ships
    // no session-share command, so it no longer reads config at all — the point
    // of the original assertion (never reach for sync.data.config) is kept below.
    expect(text).not.toMatch(/\buseSync\b/)
    expect(text).not.toMatch(/sync\.session\.get/)
    expect(text).not.toMatch(/sync\.data\.message/)
    expect(text).not.toMatch(/sync\.data\.part/)
    expect(text).not.toMatch(/sync\.data\.config/)
  })

  test("upstream message timeline reads messages and parts from registered chat projection", async () => {
    const text = await upstreamAppText("features/session/ui/message-timeline.tsx")

    expect(text).toMatch(/directoryAgentsQuery\(sdk\.url, sdk\.directory, sdk\.client\)/)
    expect(text).toMatch(/directorySessionCacheQuery\(sdk\.directory\)/)
    expect(text).toMatch(/sessionStatusQuery\(sessionID\(\), sdk\.client\)/)
    expect(text).toMatch(/const directorySessionRows = createMemo/)
    expect(text).toMatch(/const directorySession = \(sessionID: string \| undefined\)/)
    expect(text).toMatch(/registeredConversationSnapshot\(id\)/)
    expect(text).toMatch(/sessionConversation\(\)\?\.messages \?\? emptyMessages/)
    expect(text).toMatch(/parentConversation\(\)\?\.messages \?\? emptyMessages/)
    expect(text).toMatch(/sessionConversation\(\)\?\.parts\[msgId\] \?\? emptyParts/)
    expect(text).toMatch(/parentConversation\(\)\?\.parts\[msgId\] \?\? emptyParts/)
    expect(text).toMatch(/messageAgentColor\(sessionMessages\(\), directoryAgentsQueryResult\.data \?\? \[\]\)/)
    expect(text).toMatch(/sessionSync\?\.syncSession\?\.\(id\)/)
    // Both config reads here existed only to gate the session-share menu, which
    // Claxedo does not ship — the timeline no longer reads directory config at
    // all. `not.toMatch(/sync\.data\.config/)` below still pins the projection.
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

  test("upstream branch labels read runtime VCS queries", async () => {
    const sessionNewView = await Bun.file(path.join(root, "features/session/ui/components/session-new-view.tsx")).text()
    const projectInfo = await Bun.file(path.join(root, "app/workbench/rail/rail-project-session-info.ts")).text()
    const helper = await Bun.file(path.join(root, "platform/runtime/workspace-query.ts")).text()

    expect(helper).toMatch(/queryKeys\.runtime\.vcs/)
    expect(helper).toMatch(/workspaceVcsQuery/)
    expect(sessionNewView).toMatch(/queryClient\.fetchQuery\(workspaceVcsQuery\(\{/)
    expect(projectInfo).toMatch(/gitBranch: git\?\.branch/)
    expect(sessionNewView).not.toMatch(/cachedRuntimeVcs/)
    expect(projectInfo).not.toMatch(/cachedRuntimeVcs/)
    expect(sessionNewView).not.toMatch(/sync\.data\.vcs/)
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
