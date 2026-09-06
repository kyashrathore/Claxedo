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

/**
 * A lazy stand-in for one port: the shell configures the ports after this module
 * is evaluated, so each export must defer the lookup to call time. Reading the
 * port through `select` keeps the argument and return types inferred from the
 * real function, which is why no cast is needed to produce one.
 */
function bind<A extends unknown[], R>(select: (ports: OnboardingAppPorts) => (...args: A) => R) {
  return (...args: A) => select(required())(...args)
}

export const ProviderList = bind((ports) => ports.ProviderList)
export const ProviderConnectForm = bind((ports) => ports.ProviderConnectForm)
export const workspaceSandboxDriversUrl = bind((ports) => ports.workspaceSandboxDriversUrl)
export const workspaceSandboxDriverAuthUrl = bind((ports) => ports.workspaceSandboxDriverAuthUrl)
export const SandboxDriverLogo = bind((ports) => ports.SandboxDriverLogo)
