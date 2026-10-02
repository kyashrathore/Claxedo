import type { AgentPermissionMode, AutoLevel } from "./permissions"

/**
 * When a change lands. `next-session` is a harness whose options are read only
 * when its agent is created, and that cannot recreate the agent in front of
 * the user. `immediate` uses a live session control.
 */
export type PermissionModesApplyFrom = "immediate" | "next-turn" | "next-session"

export type HarnessPermissionModes = {
  modes: readonly AgentPermissionMode[]
  appliesFrom: PermissionModesApplyFrom
  /**
   * The mode a session runs under before anyone has chosen, as the transport
   * launches it. Absent where the harness's own configuration decides instead,
   * so a session that chose nothing names no mode.
   */
  defaultModeId?: string
}

const mode = (id: string, name: string, description: string, level?: AutoLevel): AgentPermissionMode => ({
  id,
  name,
  description,
  ...(level ? { level } : {}),
})

/**
 * Claude's `PermissionMode` union, with the SDK's OWN descriptions copied from
 * its doc comment (`sdk.d.ts`) so the picker never paraphrases.
 *
 * `plan` and `dontAsk` carry no rung. `plan` executes nothing and `dontAsk`
 * DENIES rather than allows, so neither sits on an allow-more ladder at all.
 * `acceptEdits` carries none either: it still prompts for every command.
 *
 * `immediate`: streaming queries acknowledge `setPermissionMode()` without
 * restarting the active turn.
 */
export const CLAUDE_PERMISSION_MODES = {
  modes: [
    mode("default", "Default", "Standard behavior, prompts for dangerous operations", "ask"),
    mode("acceptEdits", "Accept edits", "Auto-accept file edit operations"),
    /**
     * Claxedo's automatic rung allows safe tiers and escalates dangerous work.
     * Anthropic's classifier mode implements that policy across edits, Bash, and
     * MCP calls.
     */
    mode("auto", "Auto", "Use a model classifier to approve/deny permission prompts", "auto"),
    mode("plan", "Plan", "Planning mode, no actual tool execution"),
    mode("dontAsk", "Don't ask", "Don't prompt for permissions, deny if not pre-approved"),
    mode("bypassPermissions", "Bypass permissions", "Bypass all permission checks", "full"),
  ],
  appliesFrom: "immediate",
  defaultModeId: "auto",
} satisfies HarnessPermissionModes

/**
 * Cursor's two `LocalAgentOptions` booleans, presented as the combinations that
 * mean something.
 *
 * `next-turn`: both fields are read by `Agent.create` and `Agent.resume`, and
 * the per-send `LocalSendOptions` carries only `force` and `customTools`, so a
 * change closes the session's agent and the next turn resumes it with the new
 * options.
 *
 * No default: with nothing chosen the transport passes no sandbox options and
 * Cursor's own configured defaults decide. A sandboxed mode needs Cursor's
 * `cursorsandbox` binary, which the SDK refuses to run without.
 *
 * `force` is deliberately NOT mapped to a rung. It expires a wedged run after a
 * crashed CLI — a recovery flag, not a permission control — and treating it as
 * "full access" would hand a destructive-sounding label to something that does
 * not grant anything.
 */
export const CURSOR_PERMISSION_MODES = {
  modes: [
    mode("review", "Review each call", "Run tool calls inside Cursor's sandbox and review them", "ask"),
    mode("auto-review", "Auto-review", "Let Cursor's classifier approve tool calls inside the sandbox", "auto"),
    mode("unsandboxed", "Unsandboxed", "Run tool calls directly, with no sandbox", "full"),
  ],
  appliesFrom: "next-turn",
} satisfies HarnessPermissionModes

/**
 * Codex approval policy + sandbox pairs. `auto` here is the strongest `auto` of
 * any harness: `on-request` with a workspace-write sandbox means in-workspace
 * commands run unprompted and the boundary is enforced by the OS
 * (seatbelt/landlock), not by an allowlist.
 */
export const CODEX_PERMISSION_MODES = {
  modes: [
    mode("read-only", "Read only", "Never asks; the sandbox permits reads only, so writes fail", "ask"),
    mode("workspace-write", "Workspace write", "Runs commands inside the workspace without asking; escalates outside it", "auto"),
    mode("untrusted", "Untrusted", "Only trusted commands run without asking; anything else escalates"),
    mode("full-access", "Full access", "Never asks; full filesystem and network access", "full"),
  ],
  appliesFrom: "next-turn",
  defaultModeId: "workspace-write",
} satisfies HarnessPermissionModes
