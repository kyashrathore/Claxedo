export type HarnessMode = "workspace" | "central"

export type WorkspaceProfile = "full" | "minimal"

export function harnessMode(input?: string | null): HarnessMode {
  return input === "central" ? "central" : "workspace"
}

export function workspaceProfile(mode: HarnessMode): WorkspaceProfile {
  return mode === "central" ? "minimal" : "full"
}

export function profileFromEnv(env = process.env): WorkspaceProfile {
  return workspaceProfile(harnessMode(env.CLAXEDO_HARNESS_MODE))
}
