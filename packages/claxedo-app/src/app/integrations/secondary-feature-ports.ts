import { rendererTraceEnabled } from "@/platform/performance/renderer-trace"
import { lazy, onMount } from "solid-js"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { createHarnessConnectionsCatalog } from "@/platform/query/connection-catalog"
import { lazyDialog } from "@/lib/lazy-dialog"
import { configureTerminalAppPorts } from "@/features/terminal/app-ports"
import { configureSettingsAppPorts } from "@/features/settings/app-ports"
import { configureOnboardingAppPorts } from "@/features/onboarding/app-ports"
import { configureReviewAppPorts } from "@/features/review/app-ports"
import * as SDK from "@/app/providers/sdk/sdk"
import * as GlobalSDK from "@/app/providers/global-sdk/provider"
import * as Command from "@/app/providers/command"
import * as FileContext from "@/app/providers/file"
import * as Providers from "@/app/providers/use-providers"
import * as QueryOptions from "@/app/integrations/sync/query-options"
import * as State from "@/app/workbench/state"
import * as Events from "@/app/integrations/claxedo-events"
import * as SessionScope from "@/features/session/ui/components/session-pane-scope"
import * as Navigation from "@/app/workbench/navigation/navigation-row"
import * as WorkspaceConnection from "@/features/workspaces/data/workspace-connection"
import * as WorkspaceRecovery from "@/features/workspaces/actions/workspace-recovery"
import * as TerminalNew from "@/app/workbench/terminal/terminal-new-view"
import * as AIConnectApi from "@/features/onboarding/ai-connect-api"
import * as AIConnectState from "@/features/onboarding/ai-connect-state"
import * as TerminalAgents from "@/features/terminal/core/terminal-agents"
import * as TerminalCommands from "@/features/terminal/core/terminal-commands"
import * as SessionModels from "@/features/session/providers/models"
import * as HarnessModelOptions from "@/features/session/harness/harness-model-options"
import * as LinkModule from "@/app/controls/link"
import * as SandboxSectionLogic from "@/features/settings/ui/sandbox-section-logic"
import * as SandboxDriverLogoModule from "@/features/settings/ui/sandbox-driver-logo"
import * as ProjectCreateFormModule from "@/features/workspaces/ui/project-create-form"
import * as ProjectApi from "@/features/workspaces/data/project-api"
import * as MachineAccounts from "@/features/settings/machine-accounts"
import * as AgentsSection from "@/features/settings/ui/agents-section"
import * as HarnessProviders from "@/features/settings/ui/harness-providers-section"
import * as Prompt from "@/features/session/providers/prompt"
import * as PanePreferences from "@/features/session/preferences/pane"
import { DialogConnectIntegration } from "./feature-ports"
import { useOnboardingFunnel } from "./onboarding-funnel"

const DialogConnectProvider = lazyDialog(() =>
  import("@/app/dialogs/connect-provider").then((module) => ({ default: module.DialogConnectProvider })),
)
const DialogSelectProvider = lazyDialog(() =>
  import("@/app/dialogs/select-provider").then((module) => ({ default: module.DialogSelectProvider })),
)
const DialogCustomProvider = lazyDialog(() =>
  import("@/app/dialogs/custom-provider").then((module) => ({ default: module.DialogCustomProvider })),
)
const ProviderConnectForm = lazy(() =>
  import("@/app/dialogs/provider-connect-form").then((module) => ({ default: module.ProviderConnectForm })),
)
const DialogReleaseNotes = lazyDialog(() =>
  import("@/app/dialogs/release-notes").then((module) => ({ default: module.DialogReleaseNotes })),
)

configureTerminalAppPorts({
  useSDK: SDK.useSDK,
  useClaxedoEventsOptional: Events.useClaxedoEventsOptional,
  useClaxedoState: State.useClaxedoState,
  SessionPaneScope: SessionScope.SessionPaneScope,
  NavigationRow: Navigation.NavigationRow,
  NavigationStatusMark: Navigation.NavigationStatusMark,
  NavigationRowStatusGutter: Navigation.NavigationRowStatusGutter,
  NavigationRowGlyph: Navigation.NavigationRowGlyph,
  workspacePlacement: WorkspaceConnection.workspaceRelayPlacement,
  recoverMissingWorkspace: WorkspaceRecovery.recoverMissingWorkspace,
  TerminalNewView: TerminalNew.TerminalNewView,
})

configureSettingsAppPorts({
  useProviders: Providers.useProviders,
  useGlobalSDK: GlobalSDK.useGlobalSDK,
  useShellQueryOptions: QueryOptions.useShellQueryOptions,
  DialogConnectProvider,
  DialogSelectProvider,
  DialogCustomProvider,
  verifyAIConnection: AIConnectApi.verifyAIConnection,
  loadMachineLogins: AIConnectApi.loadMachineLogins,
  useMachineLogin: AIConnectApi.useMachineLogin,
  localHarnessChecks: AIConnectState.localHarnessChecks,
  terminalAgents: TerminalAgents.TERMINAL_AGENTS,
  getTerminalCommands: TerminalCommands.getTerminalCommands,
  saveTerminalCommands: TerminalCommands.saveTerminalCommands,
  defaultTerminalCommands: TerminalCommands.defaultTerminalCommands,
  useModelVisibility: SessionModels.useModelVisibility,
  loadHarnessModelOptions: HarnessModelOptions.loadHarnessModelOptions,
  groupHarnessModels: HarnessModelOptions.groupHarnessModels,
  formatKeybind: Command.formatKeybind,
  parseKeybind: Command.parseKeybind,
  useCommand: Command.useCommand,
  DialogConnectIntegration,
  ProviderConnectForm,
  Link: LinkModule.Link,
  useSandboxOnboardingFunnel: useOnboardingFunnel,
  useSDK: SDK.useSDK,
  useEnabledAcpHarnesses: () => {
    const catalog = createHarnessConnectionsCatalog({ base: getClaxedoServerUrl(), request: authFetch })
    onMount(() => void catalog.refresh())
    return () => {
      const data = catalog.data()
      return data?.status === "supported"
        ? data.connections.filter((row) => row.enabled).map((row) => ({ key: row.connectionId, label: row.label }))
        : []
    }
  },
})

configureOnboardingAppPorts({
  ProjectCreateForm: ProjectCreateFormModule.ProjectCreateForm,
  createProject: ProjectApi.createProject,
  projectRequestMessage: ProjectApi.projectRequestMessage,
  projectRequestCode: ProjectApi.projectRequestCode,
  projectByCheckout: ProjectApi.projectByCheckout,
  MachineAccountsProvider: MachineAccounts.MachineAccountsProvider,
  useMachineAccounts: MachineAccounts.useMachineAccounts,
  AgentHarnessAccounts: AgentsSection.AgentHarnessAccounts,
  HarnessProvidersSection: HarnessProviders.HarnessProvidersSection,
  useProviders: Providers.useProviders,
  workspaceSandboxDriversUrl: SandboxSectionLogic.workspaceSandboxDriversUrl,
  workspaceSandboxDriverAuthUrl: SandboxSectionLogic.workspaceSandboxDriverAuthUrl,
  SandboxDriverLogo: SandboxDriverLogoModule.SandboxDriverLogo,
})

configureReviewAppPorts({
  useFile: FileContext.useFile,
  usePrompt: Prompt.usePrompt,
  useSDK: SDK.useSDK,
  createPanePreferences: PanePreferences.createPanePreferences,
  reviewModePreferenceScope: PanePreferences.reviewModePreferenceScope,
  DialogReleaseNotes,
})

if (rendererTraceEnabled()) {
  performance.mark("runtime.secondaryFeaturePortsModuleEvaluated")
}

/**
 * Tasks, in a chunk of its own.
 *
 * The import is dynamic so Rollup keeps `features/tasks/**` out of the chunks
 * the shell needs before first paint. Registration is awaited by
 * `preloadRuntimeProviders()` through this export, which is what keeps a
 * restored Tasks tab from painting the surface fallback while that chunk is
 * still in flight.
 *
 * It is wired here rather than in the first-party surface list because that
 * list is reached from the published local entry, whose closure must stay free
 * of hosted capability modules; this wiring runs only once the shell is being
 * composed.
 */
export const secondaryFeaturePortsReady: Promise<void> = import(
  "@/app/integrations/tasks-contributions"
).then((module) => module.loadTasksContributions())
