export {
  AgentExtensionConflictError,
  allAgentExtensionTargets,
  type AgentExtensionLifecycleResult,
} from "@claxedo/agent-extensions"
import {
  disableAgentExtension as disablePackageAgentExtension,
  enableAgentExtension as enablePackageAgentExtension,
  installCachedAgentExtension as installCachedPackageAgentExtension,
  installFetchedAgentExtension as installFetchedPackageAgentExtension,
  installGitHubAgentExtension as installGitHubPackageAgentExtension,
  uninstallAgentExtension as uninstallPackageAgentExtension,
  updateAgentExtension as updatePackageAgentExtension,
  type AgentExtensionLifecycleInput as PackageAgentExtensionLifecycleInput,
  type InstallCachedAgentExtensionInput as PackageInstallCachedAgentExtensionInput,
  type InstallFetchedAgentExtensionInput as PackageInstallFetchedAgentExtensionInput,
  type InstallGitHubAgentExtensionInput as PackageInstallGitHubAgentExtensionInput,
} from "@claxedo/agent-extensions"
import { fanOutConfig } from "../config-fanout"
import { dataDir } from "../lib/paths"

export type InstallCachedAgentExtensionInput = Omit<PackageInstallCachedAgentExtensionInput, "dataRoot"> & { dataRoot?: string }
export type InstallFetchedAgentExtensionInput = Omit<PackageInstallFetchedAgentExtensionInput, "dataRoot"> & { dataRoot?: string }
export type InstallGitHubAgentExtensionInput = Omit<PackageInstallGitHubAgentExtensionInput, "dataRoot"> & { dataRoot?: string }
export type AgentExtensionLifecycleInput = Omit<PackageAgentExtensionLifecycleInput, "dataRoot"> & { dataRoot?: string }

async function broadcastExtensionChange() {
  await fanOutConfig().catch(() => undefined)
}

function withDataRoot<T extends { dataRoot?: string }>(input: T): T & { dataRoot: string } {
  return {
    ...input,
    dataRoot: input.dataRoot ?? dataDir(),
  }
}

async function withBroadcast<T>(operation: Promise<T>) {
  const result = await operation
  if (result !== undefined) await broadcastExtensionChange()
  return result
}

export function installCachedAgentExtension(input: InstallCachedAgentExtensionInput) {
  return withBroadcast(installCachedPackageAgentExtension(withDataRoot(input)))
}

export function installFetchedAgentExtension(input: InstallFetchedAgentExtensionInput) {
  return withBroadcast(installFetchedPackageAgentExtension(withDataRoot(input)))
}

export function installGitHubAgentExtension(input: InstallGitHubAgentExtensionInput) {
  return withBroadcast(installGitHubPackageAgentExtension(withDataRoot(input)))
}

export function updateAgentExtension(input: AgentExtensionLifecycleInput) {
  return withBroadcast(updatePackageAgentExtension(withDataRoot(input)))
}

export function disableAgentExtension(input: AgentExtensionLifecycleInput) {
  return withBroadcast(disablePackageAgentExtension(withDataRoot(input)))
}

export function enableAgentExtension(input: AgentExtensionLifecycleInput) {
  return withBroadcast(enablePackageAgentExtension(withDataRoot(input)))
}

export function uninstallAgentExtension(input: AgentExtensionLifecycleInput) {
  return withBroadcast(uninstallPackageAgentExtension(withDataRoot(input)))
}
