import type { WorkspaceProfile } from "./profile"

export type WorkspaceCapabilities = {
  /** Compatibility profile for the current runtime surface. Always `workspace`. */
  profile: WorkspaceProfile
  /** Whether the workspace harness (the central harness-host process)
   *  is active in this runtime. False means only explicitly enabled
   *  capabilities should be treated as available. */
  workspace_harness_enabled: boolean
  /** This runtime hosts session APIs like prompt, abort, fork, and command execution. */
  session_host: boolean
  /** This runtime owns the live agent harness process and can swap/apply harness config. */
  harness_host: boolean
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
   * The control plane can still manage MCP config globally even when this is false.
   */
  mcp: boolean
  /**
   * Opencode-backed LSP status APIs are available on this runtime.
   * This is not a generic capability for non-opencode runners.
   */
  lsp: boolean
  /**
   * Opencode-backed VCS metadata APIs are available on this runtime.
   * This is not a generic capability for non-opencode runners.
   */
  vcs: boolean
}

export type WorkspaceRpc = {
  health: () => Promise<unknown>
  /** Returns the capability manifest for the current workspace runtime state. */
  capabilities: () => Promise<WorkspaceCapabilities>
}

export function workspaceCapabilities(enabled: boolean): WorkspaceCapabilities {
  return {
    profile: "workspace",
    workspace_harness_enabled: enabled,
    session_host: enabled,
    harness_host: enabled,
    command: enabled,
    pty: true,
    process: true,
    diff: true,
    config: true,
    mcp: enabled,
    lsp: enabled,
    vcs: enabled,
  }
}
