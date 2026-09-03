import type * as Providers from "@/app/providers/use-providers"
import type * as GlobalSDK from "@/app/providers/global-sdk/provider"
import type * as QueryOptions from "@/app/integrations/sync/query-options"
import type * as ConnectProvider from "@/app/dialogs/connect-provider"
import type * as ConnectAI from "@/app/dialogs/connect-ai"
import type * as SelectProvider from "@/app/dialogs/select-provider"
import type * as CustomProvider from "@/app/dialogs/custom-provider"
import type * as Models from "@/features/session/providers/models"
import type * as Command from "@/app/providers/command"
import type * as ConnectIntegration from "@/app/dialogs/connect-integration"
import type * as ProviderConnectFormModule from "@/app/dialogs/provider-connect-form"
import type * as LinkModule from "@/app/controls/link"
import type * as SettingsSourceViews from "@/app/integrations/settings-source-views"
import type * as SDK from "@/app/providers/sdk/sdk"

export type SourceViewProject = SettingsSourceViews.SourceViewProject

export type SettingsAppPorts = {
  useProviders: typeof Providers.useProviders
  useGlobalSDK: typeof GlobalSDK.useGlobalSDK
  useShellQueryOptions: typeof QueryOptions.useShellQueryOptions
  DialogConnectProvider: typeof ConnectProvider.DialogConnectProvider
  DialogAIConnect: typeof ConnectAI.DialogAIConnect
  DialogSelectProvider: typeof SelectProvider.DialogSelectProvider
  DialogCustomProvider: typeof CustomProvider.DialogCustomProvider
  useModels: typeof Models.useModels
  formatKeybind: typeof Command.formatKeybind
  parseKeybind: typeof Command.parseKeybind
  useCommand: typeof Command.useCommand
  DialogConnectIntegration: typeof ConnectIntegration.DialogConnectIntegration
  ProviderConnectForm: typeof ProviderConnectFormModule.ProviderConnectForm
  Link: typeof LinkModule.Link
  useSettingsSourceViews: typeof SettingsSourceViews.useSettingsSourceViews
  useSandboxOnboardingFunnel: () => {
    emit(event: { name: "sandbox_provider_configured"; provider: string }): void
  }
  useSDK: typeof SDK.useSDK
  /** The operator ACP connections the picker offers alongside the built-in harnesses. */
  useEnabledAcpHarnesses: () => () => Array<{ key: string; label: string }>
  /** The harness a workspace was last used with, from its draft-default record. */
  readWorkspaceHarnessDefault: (input: { serverUrl: string; workspaceKey: string }) => string | undefined
}

let ports: SettingsAppPorts | undefined

export function configureSettingsAppPorts(value: SettingsAppPorts) {
  ports = value
}

function required() {
  if (!ports) throw new Error("Settings app ports are not configured")
  return ports
}

function bind<K extends keyof SettingsAppPorts>(key: K) {
  return ((...args: never[]) => (required()[key] as (...values: never[]) => unknown)(...args)) as SettingsAppPorts[K]
}

export const useProviders = bind("useProviders")
export const useGlobalSDK = bind("useGlobalSDK")
export const useShellQueryOptions = bind("useShellQueryOptions")
export const DialogConnectProvider = bind("DialogConnectProvider")
export const DialogAIConnect = bind("DialogAIConnect")
export const DialogSelectProvider = bind("DialogSelectProvider")
export const DialogCustomProvider = bind("DialogCustomProvider")
export const useModels = bind("useModels")
export const formatKeybind = bind("formatKeybind")
export const parseKeybind = bind("parseKeybind")
export const useCommand = bind("useCommand")
export const DialogConnectIntegration = bind("DialogConnectIntegration")
export const ProviderConnectForm = bind("ProviderConnectForm")
export const Link = bind("Link")
export const useSettingsSourceViews = bind("useSettingsSourceViews")
export const useSandboxOnboardingFunnel = bind("useSandboxOnboardingFunnel")
export const useSDK = bind("useSDK")
export const useEnabledAcpHarnesses = bind("useEnabledAcpHarnesses")
export const readWorkspaceHarnessDefault = bind("readWorkspaceHarnessDefault")
