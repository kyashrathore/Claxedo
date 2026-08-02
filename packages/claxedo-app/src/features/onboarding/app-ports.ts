// Onboarding renders two surfaces the app shell owns — the provider catalog and
// the provider connect form — and reads the sandbox driver route that settings
// owns. Features may not import `app/` or each other directly, so the shell
// injects them here and onboarding depends only on this contract.

import type * as ProviderListModule from "@/app/dialogs/provider-list"
import type * as ProviderConnectFormModule from "@/app/dialogs/provider-connect-form"
import type * as SandboxSectionLogic from "@/features/settings/ui/sandbox-section-logic"
import type * as SandboxDriverLogoModule from "@/features/settings/ui/sandbox-driver-logo"

export type OnboardingAppPorts = {
  ProviderList: typeof ProviderListModule.ProviderList
  ProviderConnectForm: typeof ProviderConnectFormModule.ProviderConnectForm
  workspaceSandboxDriversUrl: typeof SandboxSectionLogic.workspaceSandboxDriversUrl
  workspaceSandboxDriverAuthUrl: typeof SandboxSectionLogic.workspaceSandboxDriverAuthUrl
  /** The same brand marks the Settings provider picker renders. */
  SandboxDriverLogo: typeof SandboxDriverLogoModule.SandboxDriverLogo
}

let ports: OnboardingAppPorts | undefined

export function configureOnboardingAppPorts(value: OnboardingAppPorts) {
  ports = value
}

function required() {
  if (!ports) throw new Error("Onboarding app ports are not configured")
  return ports
}

function bind<K extends keyof OnboardingAppPorts>(key: K) {
  return ((...args: never[]) => (required()[key] as (...values: never[]) => unknown)(...args)) as OnboardingAppPorts[K]
}

export const ProviderList = bind("ProviderList")
export const ProviderConnectForm = bind("ProviderConnectForm")
export const workspaceSandboxDriversUrl = bind("workspaceSandboxDriversUrl")
export const workspaceSandboxDriverAuthUrl = bind("workspaceSandboxDriverAuthUrl")
export const SandboxDriverLogo = bind("SandboxDriverLogo")
