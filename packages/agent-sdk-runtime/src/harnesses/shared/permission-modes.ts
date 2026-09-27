
/**
 * The `LocalAgentOptions` fragment for a mode id, shaped for spreading straight
 * into `Agent.create({ local: … })`.
 *
 * Unknown or absent ids produce no override, leaving Cursor's configured
 * defaults authoritative.
 */
export function cursorPermissionOptions(
  modeId: string | undefined,
): { sandboxOptions?: { enabled: boolean }; autoReview?: boolean } {
  switch (modeId) {
    case "review":
      return { sandboxOptions: { enabled: true } }
    case "auto-review":
      return { sandboxOptions: { enabled: true }, autoReview: true }
    case "unsandboxed":
      return { sandboxOptions: { enabled: false } }
    default:
      return {}
  }
}

/**
 * Codex's modes as the approval policy + sandbox pair each one sends.
 *
 * Named profiles are NOT used even though `thread/settings/update` accepts them,
 * because the generated type says `permissions` "cannot be combined with
 * `sandboxPolicy`" — so a client has to pick one lane, and the explicit
 * policy/sandbox pair is the one whose meaning is legible from the request
 * itself rather than depending on how a profile id is configured on the machine.
 * `permissionProfile/list` remains the way to DISCOVER what a build offers.
 */
export type CodexPermissionSettings = {
  approvalPolicy: "untrusted" | "on-failure" | "on-request" | "never"
  sandbox: "read-only" | "workspace-write" | "danger-full-access"
}

const DEFAULT_CODEX_SETTINGS: CodexPermissionSettings = { approvalPolicy: "on-request", sandbox: "workspace-write" }

export const CODEX_SETTINGS: Record<string, CodexPermissionSettings> = {
  "read-only": { approvalPolicy: "never", sandbox: "read-only" },
  "workspace-write": DEFAULT_CODEX_SETTINGS,
  untrusted: { approvalPolicy: "untrusted", sandbox: "workspace-write" },
  "full-access": { approvalPolicy: "never", sandbox: "danger-full-access" },
}

export const codexSettingsFor = (modeId: string | undefined): CodexPermissionSettings =>
  CODEX_SETTINGS[modeId ?? ""] ?? DEFAULT_CODEX_SETTINGS

/**
 * `turn/start` takes a structured sandbox policy while `thread/start` takes the
 * bare slug. This function owns the conversion shared by both call sites.
 */
export function codexSandboxPolicy(sandbox: CodexPermissionSettings["sandbox"], directory: string) {
  if (sandbox === "read-only") return { type: "readOnly" as const }
  if (sandbox === "danger-full-access") return { type: "dangerFullAccess" as const }
  return {
    type: "workspaceWrite" as const,
    writableRoots: [directory],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  }
}

/**
 * Tool patterns denied on Claude in EVERY mode, including `bypassPermissions`.
 *
 * This goes in `settings.permissions.deny`, NOT `disallowedTools`. The two are
 * easy to confuse and only one works here: `disallowedTools` takes bare tool
 * NAMES ("List of tool names that are disallowed"), so a pattern like
 * `Bash(rm -rf *)` would match no tool at all and the floor would silently not
 * exist — worse than having no floor, because it would look like one.
 *
 * Kept deliberately short. Every entry is a command whose damage is immediate
 * and unrecoverable, so the list stays defensible without becoming a shell
 * classifier — which is the problem this repo has repeatedly declined to solve
 * by guessing.
 */
export const CLAUDE_DENY_FLOOR: readonly string[] = [
  "Bash(rm -rf /*)",
  "Bash(rm -rf ~*)",
  "Bash(git push --force*)",
  "Bash(curl *| sh)",
  "Bash(curl *| bash)",
  "Bash(wget *| sh)",
  "Bash(chmod -R 777*)",
]
