export { expect, test, type HarnessFixtures } from "./fixtures"
export { UNTRACED } from "./untraced"
export {
  ApiError,
  ClaxedoApi,
  type HarnessSelection,
  type ModelChoice,
  type ProviderCatalog,
  type PermissionRow,
  type QuestionRow,
  type SessionHarness,
  type SessionRow,
} from "./api"
export { assistantText, type MessagePart, type MessageRow } from "../../../harness/e2e/harness/api"
export { frameSessionId, frameType, openEventStream, type EventStream, type StreamFrame } from "../../../harness/e2e/harness/stream"
export { redRun, startStack, type Stack, type StackInput } from "./stack"
export { type Daemon } from "./daemon"
export { type Desktop } from "./desktop"
export { interceptSystemBrowser, signInDesktop, type SystemBrowser } from "./system-browser"
export { type Workspace } from "../../../harness/e2e/harness/workspaces"
export { git, gitFolder } from "../../../harness/e2e/harness/git"
export { type GitRemote } from "./git-remote"
export { type LocalPages } from "./local-pages"
export { type ConnectionSink } from "./connection-sink"
export { type HttpTransport } from "../../../harness/e2e/harness/transport"
export { pageTransport } from "./page-transport"
export { listLivePlugins, registerLivePlugin, writeLivePlugin, type LivePluginFolder, type LivePluginRow } from "./live-plugins"
export { APP_PLUGIN_WARNING, appPluginDialog, appPluginRow, approveAppPlugin } from "./app-plugins"
export { breakFixturePlugin, FIXTURE_ROUTES, fixtureFolder, writeFixturePlugin, type FixtureVersion } from "./fixture-plugin"
export { type Account, type SignedStack } from "./signed-stack"
export { ownerDevices, revokeOwnerMachines, servingMachineName } from "./machine-devices"
export {
  cloudMessages, cloudPrompt, cloudTurn, cloudWorkspaceNames, cloudWorkspaces, createCloudSession, listedSessions, makeCloudWorkspace, sessionConnection, startCloudWorkspace, stopCloudWorkspace,
  storedMessages, storeOwnerKey, type CloudWorkspace,
} from "./cloud"
export { SCRIPTED_ACP_CONNECTION_ID, SCRIPTED_ACP_HARNESS, UNSET_ACP_HARNESS } from "../../../harness/e2e/harness/acp/connection"
export { scriptedAgentPids } from "./acp/agent-process"
export { acpScriptToken, type AcpScript, type AcpStep, type AcpToolStep } from "../../../harness/e2e/harness/acp/script"
export { installedCli, type CliAvailability, type CliName } from "./installed-cli"
export { REFUSED_BACKGROUND_TARGETS, unexpectedEgress, type EgressAttempt, type EgressGuard } from "../../../harness/e2e/harness/egress-guard"
export { SCRIPTED_SECRET, type ScriptedProviderId } from "../../../harness/e2e/harness/scripted-providers"
export { APP_SCRIPTED_PROVIDER_IDS } from "./scripted-world"
export { type ScriptedModelRequest, type ScriptedModelServer, type ScriptedToolCall } from "../../../harness/e2e/harness/scripted-model-server"
export { expectWithinBaseline, settled, type Surface } from "./a11y"
export { expectNothingAnimating } from "./animations"
export { sessionRoute, UI } from "./ui-names"
export { sendPrompt, showHarnesses, type SendOptions } from "./composer"
export { apiRequests, holdEveryRequest, holdResponse } from "./requests"
export { recordStillness, sinceFirstReady, stillnessAfter, type Stillness } from "./stillness"
export { watchPageWork, type PageWork, type PageWorkInput } from "./page-work"
export { uncovered } from "./occlusion"
export { processAlive } from "../../../harness/e2e/harness/process-alive"
