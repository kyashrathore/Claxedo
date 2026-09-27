import type * as ProjectCreateFormModule from "@/features/workspaces/ui/project-create-form"
import type * as ProjectApi from "@/features/workspaces/data/project-api"
import type * as MachineAccounts from "@/features/settings/machine-accounts"
import type * as AgentsSection from "@/features/settings/ui/agents-section"
import type * as HarnessProviders from "@/features/settings/ui/harness-providers-section"
import type * as Providers from "@/app/providers/use-providers"

export type OnboardingAppPorts = {
  ProjectCreateForm: typeof ProjectCreateFormModule.ProjectCreateForm
  createProject: typeof ProjectApi.createProject
  projectRequestMessage: typeof ProjectApi.projectRequestMessage
  projectRequestCode: typeof ProjectApi.projectRequestCode
  projectByCheckout: typeof ProjectApi.projectByCheckout
  MachineAccountsProvider: typeof MachineAccounts.MachineAccountsProvider
  useMachineAccounts: typeof MachineAccounts.useMachineAccounts
  AgentHarnessAccounts: typeof AgentsSection.AgentHarnessAccounts
  HarnessProvidersSection: typeof HarnessProviders.HarnessProvidersSection
  useProviders: typeof Providers.useProviders
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
export const projectRequestCode = bind((ports) => ports.projectRequestCode)
export const projectByCheckout = bind((ports) => ports.projectByCheckout)
export const MachineAccountsProvider = bind((ports) => ports.MachineAccountsProvider)
export const useMachineAccounts = bind((ports) => ports.useMachineAccounts)
export const AgentHarnessAccounts = bind((ports) => ports.AgentHarnessAccounts)
export const HarnessProvidersSection = bind((ports) => ports.HarnessProvidersSection)
export const useProviders = bind((ports) => ports.useProviders)
