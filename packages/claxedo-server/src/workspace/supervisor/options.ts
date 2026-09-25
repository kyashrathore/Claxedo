import type { WorkspaceSupervisorOptions } from "./runtime-env"
import type { SandboxDriver } from "@claxedo/sandbox-manager"

export type ConfiguredWorkspaceSupervisorOptions = WorkspaceSupervisorOptions & { sandboxDriver?: SandboxDriver }

let options: ConfiguredWorkspaceSupervisorOptions | undefined

export function configureWorkspaceSupervisorOptions(input: ConfiguredWorkspaceSupervisorOptions) {
  options = input
}

export function needWorkspaceSupervisorOptions() {
  if (!options) throw new Error("workspace supervisor not configured")
  return options
}

export function workspaceSupervisorServerUrl() {
  return needWorkspaceSupervisorOptions().server_url.replace(/\/+$/, "")
}
