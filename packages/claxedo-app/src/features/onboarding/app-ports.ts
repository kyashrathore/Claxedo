// The sandbox provider reads and writes go to the driver routes whose URL
// builder settings owns. Features may not import each other directly, so the
// shell injects it here and onboarding depends only on this contract.

import type * as SandboxSectionLogic from "@/features/settings/ui/sandbox-section-logic"

export type OnboardingAppPorts = {
  workspaceSandboxDriversUrl: typeof SandboxSectionLogic.workspaceSandboxDriversUrl
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

export const workspaceSandboxDriversUrl = bind((ports) => ports.workspaceSandboxDriversUrl)
