import { rendererTraceEnabled } from "@/platform/performance/renderer-trace"
import { lazy } from "solid-js"
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
import * as SessionModels from "@/features/session/providers/models"
import * as LinkModule from "@/app/controls/link"
import * as SandboxSectionLogic from "@/features/settings/ui/sandbox-section-logic"
import * as Prompt from "@/features/session/providers/prompt"
import * as PanePreferences from "@/features/session/preferences/pane"
import * as HarnessControllers from "@/features/session/composer/ui/harness-controller"
import * as DraftDefaults from "@/features/session/harness/draft-defaults"
import { DialogConnectIntegration, useOnboardingFunnel } from "./feature-ports"

const DialogConnectProvider = lazyDialog(() =>
  import("@/app/dialogs/connect-provider").then((module) => ({ default: module.DialogConnectProvider })),
)
const DialogAIConnect = lazyDialog(() =>
  import("@/app/dialogs/connect-ai").then((module) => ({ default: module.DialogAIConnect })),
)
const DialogSelectProvider = lazyDialog(() =>
  import("@/app/dialogs/select-provider").then((module) => ({ default: module.DialogSelectProvider })),
)
const DialogCustomProvider = lazyDialog(() =>
  import("@/app/dialogs/custom-provider").then((module) => ({ default: module.DialogCustomProvider })),
)
const ProviderList = lazy(() =>
  import("@/app/dialogs/provider-list").then((module) => ({ default: module.ProviderList })),
)
const ProviderConnectForm = lazy(() =>
  import("@/app/dialogs/provider-connect-form").then((module) => ({ default: module.ProviderConnectForm })),
)
const SandboxDriverLogo = lazy(() =>
  import("@/features/settings/ui/sandbox-driver-logo").then((module) => ({ default: module.SandboxDriverLogo })),
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
  NavigationStatusDot: Navigation.NavigationStatusDot,
  NavigationRowStatusGutter: Navigation.NavigationRowStatusGutter,
  NavigationRowGlyph: Navigation.NavigationRowGlyph,
  workspacePlacement: WorkspaceConnection.workspacePlacement,
  recoverMissingWorkspace: WorkspaceRecovery.recoverMissingWorkspace,
  TerminalNewView: TerminalNew.TerminalNewView,
})

configureSettingsAppPorts({
  useProviders: Providers.useProviders,
  useGlobalSDK: GlobalSDK.useGlobalSDK,
  useShellQueryOptions: QueryOptions.useShellQueryOptions,
  DialogConnectProvider,
  DialogAIConnect,
  DialogSelectProvider,
  DialogCustomProvider,
  useModels: SessionModels.useModels,
  formatKeybind: Command.formatKeybind,
  parseKeybind: Command.parseKeybind,
  useCommand: Command.useCommand,
  DialogConnectIntegration,
  ProviderConnectForm,
  Link: LinkModule.Link,
  useSandboxOnboardingFunnel: useOnboardingFunnel,
  useSDK: SDK.useSDK,
  useEnabledAcpHarnesses: () => {
    const selection = HarnessControllers.usePromptHarnessControllersOptional().selection
    return () => selection ? selection.enabledAcpConnections() : []
  },
  readWorkspaceHarnessDefault: (input) =>
    DraftDefaults.createDraftDefaultPreferences(localStorage).read(input)?.harness,
})

configureOnboardingAppPorts({
  ProviderList,
  ProviderConnectForm,
  workspaceSandboxDriversUrl: SandboxSectionLogic.workspaceSandboxDriversUrl,
  workspaceSandboxDriverAuthUrl: SandboxSectionLogic.workspaceSandboxDriverAuthUrl,
  SandboxDriverLogo,
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
