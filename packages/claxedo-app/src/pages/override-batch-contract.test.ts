import { describe, expect, test } from "bun:test"

const root = new URL("../", import.meta.url)

const files = {
  app: "app.tsx",
  home: "pages/home.tsx",
  directoryLayout: "pages/directory-layout.tsx",
  session: "pages/session.tsx",
  sessionLayout: "pages/session/session-layout.ts",
  sessionHeader: "components/session/session-header.tsx",
  sessionContextTab: "components/session/session-context-tab.tsx",
  sessionNewView: "components/session/session-new-view.tsx",
  commands: "pages/session/use-session-commands.tsx",
  error: "pages/error.tsx",
  settingsGeneral: "components/settings-general.tsx",
  dialogConnectProvider: "components/dialog-connect-provider.tsx",
  dialogSelectDirectory: "components/dialog-select-directory.tsx",
  dialogSelectFile: "components/dialog-select-file.tsx",
  extensionsApp: "extensions/app.tsx",
  extensionsTypes: "extensions/types.ts",
  settingsAccount: "components/settings-account-section.tsx",
  promptInput: "session-client/composer/composer.tsx",
  promptSubmit: "components/prompt-input/submit.ts",
  sessionComposerRegion: "pages/session/composer/session-composer-region.tsx",
  terminalComponent: "components/terminal.tsx",
  persist: "utils/persist.ts",
  serverContext: "context/server.tsx",
  notificationContext: "context/notification.tsx",
  layoutContext: "context/layout.tsx",
  claxedoLayout: "shell/app-shell.tsx",
  routeBridge: "claxedo-ui/state/route-bridge.tsx",
} as const

async function source(path: string) {
  return await Bun.file(new URL(path, root)).text()
}

describe("upstream contract", () => {
  test("keeps the upstream route spine while composing Claxedo directly", async () => {
    const app = await source(files.app)

    expect(await Bun.file(new URL("overrides/app.tsx", root)).exists()).toBe(false)
    expect(app).toContain("<ServerProvider")
    expect(app).toContain("<GlobalSyncProvider>")
    expect(app).toContain("<Route path=\"/:dir\"")
    expect(app).toContain("path=\"/s/:sessionId\"")
    expect(app.indexOf("path=\"/marketplace\"")).toBeLessThan(app.indexOf("<Route path=\"/:dir\""))
    expect(app).toContain("path=\"/w/:workspaceId\"")
    expect(app).not.toContain("ServerKey")
    expect(app).toContain("path=\"/permissions\"")
    expect(app).toContain("path=\"/config\"")
    // The per-pane provider chain (Local, WorkspaceSDK, Sync, Terminal,
    // Prompt, Comments) is mounted by Workbench `DirectoryScope`, not by
    // the /:dir route (rubric C4). See `claxedo-ui/components/directory-scope.tsx`.
  })

  test("keeps upstream navigation, project, theme, and session command surfaces visible in first-party route pages", async () => {
    const session = await source(files.session)
    const commands = await source(files.commands)

    expect(await Bun.file(new URL("overrides/pages/layout.tsx", root)).exists()).toBe(false)
    expect(await Bun.file(new URL("overrides/pages/session.tsx", root)).exists()).toBe(false)
    expect(await Bun.file(new URL("overrides/pages/session/use-session-commands.tsx", root)).exists()).toBe(false)
    expect(session).toContain("<MessageTimeline")
    expect(session).toContain("<SessionComposerRegion")
    expect(commands).toContain("model.choose")
    expect(commands).toContain("session.fork")
    expect(commands).toContain("session.abort")
  })

  test("INTENTIONAL DIVERGENCE: upstream would compose through generic app extensions, Claxedo mounts owned behavior directly", async () => {
    const app = await source(files.app)
    const home = await source(files.home)
    const directory = await source(files.directoryLayout)

    // ClaxedoAppShell is mounted directly, but lazily (the workbench shell loads
    // during the ConnectionGate handshake) via ClaxedoAppShellHost — still
    // Claxedo's owned layout, not a generic app-extension slot.
    expect(app).toContain("<ClaxedoAppShellHost>")
    expect(app).toContain("import(\"@claxedo/shell/app-shell\")")
    expect(app).toContain("<CloudAuthGate>")
    expect(app).toContain("centralTransportForServer(server.url) !== \"loopback\"")
    expect(app).toContain("navigate(\"/login\", { replace: true })")
    expect(app).not.toContain("window.location.href = \"/login\"")
    expect(app).not.toContain("RuntimeGateway")
    expect(await Bun.file(new URL("overrides/pages/home.tsx", root)).exists()).toBe(false)
    expect(home).toContain("DialogCreateCloudProject")
    expect(home).toContain("ensureLocalProject")
    expect(directory).toContain("resolveSessionUrl")
    expect(directory).not.toContain("RuntimeGateway")

    for (const text of [app, home, directory]) {
      expect(text).not.toContain("getExtensions().app")
      expect(text).not.toContain("webProjectDialog")
      expect(text).not.toContain("directoryProviders")
      expect(text).not.toContain("layoutComponent")
    }
  })

  test("routes sessions through pane params while preserving upstream share commands", async () => {
    const session = await source(files.session)
    const sessionLayout = await source(files.sessionLayout)
    const commands = await source(files.commands)
    const error = await source(files.error)

    expect(session).toContain("useSessionParams")
    expect(session).toContain("NewSessionDesignView")
    expect(session).not.toContain("not in a Workbench session pane")
    expect(session).not.toContain("if (!sessionParams)")
    expect(sessionLayout).toContain("sessionParams.sessionId()")
    expect(sessionLayout).not.toContain("routeParams")
    expect(commands).toContain("session.share")
    expect(commands).toContain("session.unshare")
    expect(error).not.toContain("@sentry")
    expect(error).not.toContain("Sentry.capture")
    expect(await Bun.file(new URL("overrides/pages/error.tsx", root)).exists()).toBe(false)
  })
})

describe("Claxedo behavior", () => {
  test("every extracted route owner has a short plain top-level Claxedo comment", async () => {
    for (const path of [files.session]) {
      expect((await source(path)).split("\n")[0].startsWith("// Claxedo ")).toBe(true)
    }
  })

  test("new-session composer keeps worktree creation below the composer and wires local/cloud selection into submit", async () => {
    const session = await source(files.session)
    const design = await source("components/session/session-new-design-view.tsx")
    const workspaceOptions = await source("components/session/session-new-workspace-options.ts")
    const promptInput = await source(files.promptInput)
    const submit = await source(files.promptSubmit)

    expect(workspaceOptions).toContain("export const CREATE_WORKTREE = \"create\"")
    expect(design).toContain("Workspace environment")
    expect(design).toContain("Workspace source")
    expect(design).toContain("Create new")
    expect(design).toContain("cloud sandbox")
    expect(design).toContain("worktreePickerOpen")
    expect(design).toContain("if (!worktreePickerOpen()) return")
    expect(session).toContain("main={")
    expect(session).toContain("<CloudStartupView")
    expect(session).toContain("setStore(\"newSessionWorktree\", newSessionWorkspaceOptions(value)[0]")
    expect(session).not.toContain("changeNewSessionWorktree(newSessionWorkspaceOptions(value)[0]")
    expect(await Bun.file(new URL("overrides/components/prompt-input.tsx", root)).exists()).toBe(false)
    expect(promptInput).toContain("newSessionWorkspaceKind")
    expect(promptInput).toContain("onCloudStartup")
    expect(await Bun.file(new URL("overrides/components/prompt-input/submit.ts", root)).exists()).toBe(false)
    expect(await Bun.file(new URL("overrides/components/prompt-input/submit.test.ts", root)).exists()).toBe(false)
    expect(submit).toContain("createLocalWorktree")
    expect(submit).toContain("createCloudWorkspace")
    expect(submit).toContain("prepareCloudSessionDirectory")
    expect(submit).toContain("usesSignedControlPlane")
  })

  test("new-session model fallback is derived before submit persistence", async () => {
    const promptInput = await source(files.promptInput)

    expect(promptInput).toContain("local.model.currentSource() === \"fallback\"")
    expect(promptInput).toMatch(/firstConnectedModelInfo\(\{[\s\S]{0,120}connected: providers\.connected\(\)/)
    expect(promptInput).toMatch(/if \(shouldUsePromptFallbackModel\(\)\) return fallbackModel\(\)/)
    expect(promptInput).not.toMatch(/local\.model\.set\(/)
    expect(promptInput).toMatch(/fallbackModel:\s*\(\) => shouldUsePromptFallbackModel\(\) \? fallbackModel\(\) : undefined/)
  })

  test("signed session composer preserves relay scope for model and agent fallback", async () => {
    const session = await source(files.session)
    const composer = await source(files.sessionComposerRegion)
    const promptInput = await source(files.promptInput)
    const submit = await source(files.promptSubmit)

    expect(session).toContain("const workspace = sdk.workspace(dir()) ?? ws()")
    expect(session).toContain("sessionDirectory={dir()}")
    expect(session).toContain("signedControlPlane={signedControlPlane}")
    expect(composer).toContain("signedControlPlane?: () => boolean")
    expect(composer).toContain("sessionDirectory={sessionDirectory()}")
    expect(composer).toContain("signedControlPlane={props.signedControlPlane}")
    expect(promptInput).toContain("signedWorkspaceForDirectory({ directory, projects: projectCatalog(), sdkWorkspace: sdk.workspace(directory) })")
    expect(promptInput).toContain("const submitSessionDirectory = () =>")
    expect(promptInput).toContain("return resolveSubmitSessionDirectory({")
    expect(promptInput).toContain("workspaceId?: () => string | undefined")
    expect(promptInput).toContain("workspaceKind?: () =>")
    expect(promptInput).toContain("workspaceId: sdk.workspace(directory)?.workspaceId")
    expect(promptInput).toContain("workspaceKind: knownWorkspaceKind(signedWorkspaceForDirectory({ directory, projects: projectCatalog(), sdkWorkspace: sdk.workspace(directory) })?.kind)")
    expect(promptInput).toContain("const fallbackAgent = createMemo(() => signedWorkspaceRuntimeFallbackAgent())")
    expect(promptInput).toContain("return [...names, fallback]")
    expect(submit).toContain("workspaceId?: Accessor<string | undefined>")
    expect(submit).toContain("workspaceKind?: Accessor<\"cloud\" | \"user-hosted\" | undefined>")
    expect(submit).toContain("fallbackModel: isNewSession ? input.fallbackModel?.() : undefined")
    expect(submit).toContain("allowModelFallback: isNewSession")
    expect(submit).toContain("const runtimeRef = sessionWorkspaceRuntimeRef({ sessionRef, directory: sessionDirectory })")
    expect(submit).toContain("workspaceId: runtimeRef.workspaceId")
    expect(submit).toContain("workspaceKind: runtimeRef.kind")
  })

  test("settings account controls are direct Claxedo UI, not app extension sections", async () => {
    const settingsGeneral = await source(files.settingsGeneral)
    const extensionsApp = await source(files.extensionsApp)
    const extensionsTypes = await source(files.extensionsTypes)
    const settingsAccount = await source(files.settingsAccount)

    expect(settingsGeneral).toContain("AccountSettingsSection")
    expect(settingsGeneral).toContain("<Can do=\"view.account\">")
    expect(settingsGeneral).not.toContain("getExtensions")
    expect(settingsGeneral).not.toContain("settingsSections")
    expect(await Bun.file(new URL("overrides/components/settings-general.tsx", root)).exists()).toBe(false)
    expect(extensionsApp).not.toContain("AccountSettingsSection")
    expect(extensionsApp).not.toContain("settingsSections")
    expect(extensionsTypes).not.toContain("SettingsSectionProps")
    expect(extensionsTypes).not.toContain("settingsSections")
    expect(settingsAccount).toContain("useAuthSession")
    expect(settingsAccount).toContain("navigate(\"/login\", { replace: true })")
    expect(settingsAccount).not.toContain("@claxedo/extensions")
  })

  test("persisted storage helpers are first-party, not override-owned", async () => {
    const persist = await source(files.persist)

    expect(await Bun.file(new URL("overrides/utils/persist.ts", root)).exists()).toBe(false)
    expect(await Bun.file(new URL("overrides/utils/persist.test.ts", root)).exists()).toBe(false)
    expect(persist).toContain("serverWorkspace")
    expect(persist).toContain("resetDemoPersisted")
    expect(persist).toContain("scopeUrl")
  })

  test("directory and file pickers are first-party, not override-owned", async () => {
    const directory = await source(files.dialogSelectDirectory)
    const file = await source(files.dialogSelectFile)

    expect(await Bun.file(new URL("overrides/components/dialog-select-directory.tsx", root)).exists()).toBe(false)
    expect(await Bun.file(new URL("overrides/components/dialog-select-file.tsx", root)).exists()).toBe(false)
    expect(directory).toContain("./dialog-select-directory-routes")
    expect(directory).not.toContain("RuntimeGateway")
    expect(directory).toContain("useQueryOptions")
    expect(file).toContain("sessionViewKey")
    expect(file).toContain("sessionRoute")
  })

  test("server context is first-party, not override-owned", async () => {
    const server = await source(files.serverContext)

    expect(await Bun.file(new URL("overrides/context/server.tsx", root)).exists()).toBe(false)
    expect(server).toContain("normalizeServerUrl")
    expect(server).toContain("checkOpenCodeServerHealthCached")
    expect(server).toContain("workspaceServer")
  })

  test("notification context is first-party, not override-owned", async () => {
    const notification = await source(files.notificationContext)

    expect(await Bun.file(new URL("overrides/context/notification.tsx", root)).exists()).toBe(false)
    expect(notification).toContain("notificationViewedByScope")
    expect(notification).toContain("directorySessionCacheQueryOptions")
    expect(notification).not.toContain("playSound")
  })

  test("layout context is first-party, not override-owned", async () => {
    const layout = await source(files.layoutContext)

    expect(await Bun.file(new URL("overrides/context/layout.tsx", root)).exists()).toBe(false)
    expect(layout).toContain("export const LayoutContext = createContext")
    expect(layout).toContain("export function useLayout")
    expect(layout).toContain("export function LayoutProvider")
    expect(layout).toContain("export function getAvatarColors")
  })

  test("terminal component is first-party, not override-owned", async () => {
    const terminal = await source(files.terminalComponent)

    expect(await Bun.file(new URL("overrides/components/terminal.tsx", root)).exists()).toBe(false)
    expect(terminal).toContain("createTerminalPtyClient")
    expect(terminal).toContain("resolveWorkspaceRuntime")
    expect(terminal).toContain("getClaxedoServerUrl")
    expect(terminal).toContain("@claxedo/context/platform")
    expect(terminal).not.toContain("../../utils/api")
    expect(terminal).not.toContain("../../cloud/runtime/workspace-runtime-store")
  })

  test("new-session empty view is first-party, not override-owned", async () => {
    const view = await source(files.sessionNewView)

    expect(await Bun.file(new URL("overrides/components/session/session-new-view.tsx", root)).exists()).toBe(false)
    expect(view).toContain("directorySessionCacheQueryOptions")
    expect(view).toContain("newSessionProjectRoot")
    expect(view).not.toContain("useGlobalSync")
  })

  test("session header is first-party, not override-owned", async () => {
    const header = await source(files.sessionHeader)

    expect(await Bun.file(new URL("overrides/components/session/session-header.tsx", root)).exists()).toBe(false)
    expect(header).toContain("queryOptions.agents")
    expect(header).toContain("registeredConversationSnapshot")
    expect(header).toContain("@claxedo/components/status-popover")
    expect(header).not.toContain("useGlobalSync")
    expect(header).not.toContain("useSync")
  })

  test("session context tab is first-party, not override-owned", async () => {
    const tab = await source(files.sessionContextTab)

    expect(await Bun.file(new URL("overrides/components/session/session-context-tab.tsx", root)).exists()).toBe(false)
    expect(tab).toContain("useSessionParams")
    expect(tab).toContain("directorySessionCacheQueryOptions")
    expect(tab).toContain("registeredConversationSnapshot")
    expect(tab).not.toContain("useGlobalSync")
    expect(tab).not.toContain("useSync")
  })

  test("direct session route keeps macOS /private aliases on the canonical workspace directory", async () => {
    const routeBridge = await source(files.routeBridge)

    expect(routeBridge).toContain("sameWorkspaceDirectory")
    expect(routeBridge).toContain("function routeSessionDirectory")
    expect(routeBridge).toContain("function routeKnownSessionDirectory")
    expect(routeBridge).toContain("routeSessionDirectory(session.directory, directory)")
    expect(routeBridge).toContain("routeKnownSessionDirectory(")
  })

  test("provider connect dialog uses Claxedo credential routes for API keys and control-plane OAuth", async () => {
    const dialog = await source(files.dialogConnectProvider)

    expect(dialog).toContain("claxedoCredentialRequest")
    expect(dialog).toContain("globalSDK.client.provider.oauth.authorize")
    expect(dialog).toContain("globalSDK.client.provider.oauth.callback")
    expect(dialog).toContain("provider.connect.oauth.auto")
    expect(dialog).not.toContain("Only API key provider auth is supported")
    expect(dialog).not.toContain("globalSDK.client.auth.set")
  })
})
