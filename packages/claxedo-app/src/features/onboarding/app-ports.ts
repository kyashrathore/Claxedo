// The first-run wizard draws the Models page's own account and provider
// surfaces, creates its project through the workspaces feature's form and
// client, and writes sandbox keys to the driver routes settings owns.
// Features may not import `app/` or each other, so the shell injects each of
// those here and the wizard depends only on this contract.

import type * as ProjectCreateFormModule from "@/features/workspaces/ui/project-create-form"
import type * as ProjectApi from "@/features/workspaces/data/project-api"
import type * as MachineAccounts from "@/features/settings/machine-accounts"
import type * as AgentsSection from "@/features/settings/ui/agents-section"
import type * as HarnessProviders from "@/features/settings/ui/harness-providers-section"
import type * as Providers from "@/app/providers/use-providers"
import type * as SandboxSectionLogic from "@/features/settings/ui/sandbox-section-logic"
import type * as SandboxDriverLogoModule from "@/features/settings/ui/sandbox-driver-logo"

export type OnboardingAppPorts = {
  ProjectCreateForm: typeof ProjectCreateFormModule.ProjectCreateForm
  createProject: typeof ProjectApi.createProject
  projectRequestMessage: typeof ProjectApi.projectRequestMessage
  MachineAccountsProvider: typeof MachineAccounts.MachineAccountsProvider
  useMachineAccounts: typeof MachineAccounts.useMachineAccounts
  AgentHarnessAccounts: typeof AgentsSection.AgentHarnessAccounts
  HarnessProvidersSection: typeof HarnessProviders.HarnessProvidersSection
  useProviders: typeof Providers.useProviders
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

export const ProjectCreateForm = bind((ports) => ports.ProjectCreateForm)
export const createProject = bind((ports) => ports.createProject)
export const projectRequestMessage = bind((ports) => ports.projectRequestMessage)
export const MachineAccountsProvider = bind((ports) => ports.MachineAccountsProvider)
export const useMachineAccounts = bind((ports) => ports.useMachineAccounts)
export const AgentHarnessAccounts = bind((ports) => ports.AgentHarnessAccounts)
export const HarnessProvidersSection = bind((ports) => ports.HarnessProvidersSection)
export const useProviders = bind((ports) => ports.useProviders)
export const workspaceSandboxDriversUrl = bind((ports) => ports.workspaceSandboxDriversUrl)
export const workspaceSandboxDriverAuthUrl = bind((ports) => ports.workspaceSandboxDriverAuthUrl)
export const SandboxDriverLogo = bind((ports) => ports.SandboxDriverLogo)
