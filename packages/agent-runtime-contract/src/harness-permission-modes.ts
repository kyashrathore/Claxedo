/**
 * The three rungs every harness's permission surface is mapped onto.
 *
 * A LADDER, not a taxonomy: the rungs are ordered by how much runs without
 * asking, and that ordering is the only thing shared across harnesses. What each
 * rung concretely does is the harness's business and differs wildly — `auto` is
 * an OS sandbox on codex and a model classifier on claude and cursor.
 *
 * `level` is therefore a HINT for choosing a default, never a promise about
 * behaviour. Anything user-facing must show `AgentPermissionMode.name` — the
 * harness's own word for it — because that is the only label guaranteed to
 * describe what actually happens.
 */
export type AutoLevel = "ask" | "auto" | "full"

/** One selectable permission mode, in the harness's own vocabulary. */
export type AgentPermissionMode = {
  id: string
  /** The harness's own name. Rendered as-is; never paraphrased. */
  name: string
  description?: string
  /**
   * Which rung this is, when it maps to one at all. Absent means the harness
   * offers it but it does not correspond to a rung — still selectable, just not
   * a candidate for the default.
   */
  level?: AutoLevel
}

/**
 * When a change lands. `next-session` is not a rounding error: on cursor these
 * are `Agent.create` options, so a change cannot affect the agent already
 * created for the session in front of the user.
 */
export type PermissionModesApplyFrom = "next-turn" | "next-session"

export type HarnessPermissionModes = {
  modes: readonly AgentPermissionMode[]
  appliesFrom: PermissionModesApplyFrom
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
 * `next-turn`: `permissionMode` is read when `query()` is called, and a turn is
 * one query.
 */
export const CLAUDE_PERMISSION_MODES: HarnessPermissionModes = {
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
  appliesFrom: "next-turn",
}

/**
 * Cursor's two `LocalAgentOptions` booleans, presented as the combinations that
 * mean something.
 *
 * `next-session`: both fields are read by `Agent.create` and `Agent.resume`,
 * and the per-send `LocalSendOptions` carries only `force` and `customTools`.
 *
 * `force` is deliberately NOT mapped to a rung. It expires a wedged run after a
 * crashed CLI — a recovery flag, not a permission control — and treating it as
 * "full access" would hand a destructive-sounding label to something that does
 * not grant anything.
 */
export const CURSOR_PERMISSION_MODES: HarnessPermissionModes = {
  modes: [
    mode("review", "Review each call", "Run tool calls inside Cursor's sandbox and review them", "ask"),
    mode("auto-review", "Auto-review", "Let Cursor's classifier approve tool calls inside the sandbox", "auto"),
    mode("unsandboxed", "Unsandboxed", "Run tool calls directly, with no sandbox", "full"),
  ],
  appliesFrom: "next-session",
}

/**
 * Codex approval policy + sandbox pairs. `auto` here is the strongest `auto` of
 * any harness: `on-request` with a workspace-write sandbox means in-workspace
 * commands run unprompted and the boundary is enforced by the OS
 * (seatbelt/landlock), not by an allowlist.
 */
export const CODEX_PERMISSION_MODES: HarnessPermissionModes = {
  modes: [
    mode("read-only", "Read only", "Never asks; the sandbox permits reads only, so writes fail", "ask"),
    mode("workspace-write", "Workspace write", "Runs commands inside the workspace without asking; escalates outside it", "auto"),
    mode("untrusted", "Untrusted", "Only trusted commands run without asking; anything else escalates"),
    mode("full-access", "Full access", "Never asks; full filesystem and network access", "full"),
  ],
  appliesFrom: "next-turn",
}

/** The mode a harness runs under before anyone has chosen: its `auto` rung. */
export function defaultPermissionModeId(table: HarnessPermissionModes): string | undefined {
  return table.modes.find((candidate) => candidate.level === "auto")?.id
}
