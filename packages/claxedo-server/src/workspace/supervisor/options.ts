import type { WorkspaceSupervisorOptions } from "./runtime-env"

let options: WorkspaceSupervisorOptions | undefined

export function configureWorkspaceSupervisorOptions(input: WorkspaceSupervisorOptions) {
  options = input
}

export function needWorkspaceSupervisorOptions() {
  if (!options) throw new Error("workspace supervisor not configured")
  return options
}

export function workspaceSupervisorServerUrl() {
  return needWorkspaceSupervisorOptions().server_url.replace(/\/+$/, "")
}
