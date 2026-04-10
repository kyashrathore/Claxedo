import type { WorkspaceProfile } from "./profile"

export type WorkspaceCapabilities = {
  /** Active workspace capability profile derived from the harness mode. */
  profile: WorkspaceProfile
  /** This runtime hosts session APIs like prompt, abort, fork, and command execution. */
  session_host: boolean
  /** This runtime owns the live agent runner process and can swap/apply runner config. */
  runner_host: boolean
  /** Session command APIs are available, including listing commands and running one in a session. */
  command: boolean
  /** PTY management APIs are available for creating, updating, and streaming terminals. */
  pty: boolean
  /** Managed process APIs are available for long-running workspace services like dev servers. */
  process: boolean
  /** Standalone git diff APIs are available for comparing workspace changes. */
  diff: boolean
  /** Runtime config push is supported via `/api/wr/config`. */
  config: boolean
  /**
   * This runtime serves MCP status/connect/disconnect APIs.
   * Central harness can still manage MCP config globally even when this is false.
   */
  mcp: boolean
  /**
   * Opencode-backed LSP status APIs are available on this runtime.
   * This is not a generic harness capability for non-opencode runners.
   */
  lsp: boolean
  /**
   * Opencode-backed VCS metadata APIs are available on this runtime.
   * This is not a generic harness capability for non-opencode runners.
   */
  vcs: boolean
}

export type WorkspaceRpc = {
  health: () => Promise<unknown>
  /** Returns the capability manifest for the current workspace profile. */
  capabilities: () => Promise<WorkspaceCapabilities>
}

export function workspaceCapabilities(profile: WorkspaceProfile): WorkspaceCapabilities {
  return {
    profile,
    session_host: profile === "full",
    runner_host: profile === "full",
    command: profile === "full",
    pty: true,
    process: true,
    diff: true,
    config: true,
    mcp: profile === "full",
    lsp: profile === "full",
    vcs: profile === "full",
  }
}
