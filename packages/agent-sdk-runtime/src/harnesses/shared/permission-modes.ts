import type { AgentPermissionMode, AgentPermissionModeState, AutoLevel } from "../../adapter-contract"

/**
 * Per-session permission-mode selection for the harnesses whose mode is an
 * OPTION rather than a message.
 *
 * ACP has a request for this (`session/set_mode`), so it needs none of this file.
 * Claude and Cursor do not: their mode is a field on the object that starts the
 * work — `query({ options })` and `Agent.create` respectively — so choosing one
 * is only a promise to pass it next time. That promise has to live somewhere,
 * and a Map here is that somewhere.
 *
 * The consequence is worth stating plainly because it drives the UI: for these
 * harnesses a write CANNOT be confirmed at the time it is made. Nothing is sent.
 * `appliesFrom` is how the picker tells the user that, and it is why the field
 * is required rather than optional.
 */
export class PermissionModeSelection {
  private readonly selected = new Map<string, string>()

  constructor(
    private readonly modes: readonly AgentPermissionMode[],
    private readonly appliesFrom: "next-turn" | "next-session",
  ) {}

  /**
   * The mode this session runs under, falling back to the `auto` rung.
   *
   * Falling back to `auto` rather than `ask` is a deliberate default-on choice,
   * and it is safe HERE specifically because every `auto` rung in this file is
   * enforced by the harness — Claude's classifier, Cursor's Auto-review — rather
   * than by Claxedo answering prompts. A harness whose `auto` were merely local
   * answering must not use this default.
   */
  currentId(sessionId: string): string | undefined {
    return this.selected.get(sessionId) ?? this.modes.find((mode) => mode.level === "auto")?.id
  }

  current(sessionId: string): AgentPermissionMode | undefined {
    const id = this.currentId(sessionId)
    return id ? this.modes.find((mode) => mode.id === id) : undefined
  }

  state(sessionId: string): AgentPermissionModeState {
    const currentModeId = this.currentId(sessionId)
    return {
      modes: [...this.modes],
      ...(currentModeId ? { currentModeId } : {}),
      appliesFrom: this.appliesFrom,
    }
  }

  /**
   * Throws on an unknown id rather than storing it. A stored id the harness will
   * later fail to honour reads as applied in the UI and does nothing in fact —
   * the precise divergence this channel exists to prevent.
   */
  set(sessionId: string, modeId: string): AgentPermissionModeState {
    if (!this.modes.some((mode) => mode.id === modeId)) {
      throw new Error(`Unknown permission mode "${modeId}"`)
    }
    this.selected.set(sessionId, modeId)
    return this.state(sessionId)
  }

  forget(sessionId: string) {
    this.selected.delete(sessionId)
  }
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
 * `acceptEdits` carries the `auto` rung and the classifier mode does NOT, which
 * is the opposite of what it looks like from the names. The rung means "allow
 * reads and edits, ask before anything risky", and that is exactly what
 * `acceptEdits` does — it auto-accepts file edits while still prompting for
 * Bash. The classifier mode is broader: it can approve commands too, so making
 * it the default would hand out more than the rung promises. It stays fully
 * selectable.
 *
 * `plan` and `dontAsk` carry no rung either. `plan` executes nothing and
 * `dontAsk` DENIES rather than allows, so neither sits on an allow-more ladder
 * at all.
 */
export const CLAUDE_PERMISSION_MODES: readonly AgentPermissionMode[] = [
  mode("default", "Default", "Standard behavior, prompts for dangerous operations", "ask"),
  mode("acceptEdits", "Accept edits", "Auto-accept file edit operations", "auto"),
  mode("auto", "Auto", "Use a model classifier to approve/deny permission prompts"),
  mode("plan", "Plan", "Planning mode, no actual tool execution"),
  mode("dontAsk", "Don't ask", "Don't prompt for permissions, deny if not pre-approved"),
  mode("bypassPermissions", "Bypass permissions", "Bypass all permission checks", "full"),
]

/**
 * Cursor's two `LocalAgentOptions` booleans, presented as the combinations that
 * mean something.
 *
 * `appliesFrom: "next-session"` everywhere, and that is not pedantry: both
 * fields are read by `Agent.create`, and the per-send `LocalSendOptions` carries
 * only `force` and `customTools`. There is no mid-session write to make.
 *
 * `force` is deliberately NOT mapped to a rung. It expires a wedged run after a
 * crashed CLI — a recovery flag, not a permission control — and treating it as
 * "full access" would hand a destructive-sounding label to something that does
 * not grant anything.
 */
export const CURSOR_PERMISSION_MODES: readonly AgentPermissionMode[] = [
  mode("review", "Review each call", "Run tool calls inside Cursor's sandbox and review them", "ask"),
  mode("auto-review", "Auto-review", "Let Cursor's classifier approve tool calls inside the sandbox", "auto"),
  mode("unsandboxed", "Unsandboxed", "Run tool calls directly, with no sandbox", "full"),
]

/**
 * The `LocalAgentOptions` fragment for a mode id, shaped for spreading straight
 * into `Agent.create({ local: … })`.
 *
 * Returns `{}` for an unknown or absent id rather than a default, so an id this
 * build does not recognise leaves Cursor's own defaults untouched instead of
 * quietly imposing one of ours.
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
 * Codex approval policy + sandbox, paired.
 *
 * Named profiles are NOT used even though `thread/settings/update` accepts them,
 * because the generated type says `permissions` "cannot be combined with
 * `sandboxPolicy`" — so a client has to pick one lane, and the explicit
 * policy/sandbox pair is the one whose meaning is legible from the request
 * itself rather than depending on how a profile id is configured on the machine.
 * `permissionProfile/list` remains the way to DISCOVER what a build offers.
 *
 * `auto` here is the strongest `auto` of any harness: `on-request` with a
 * workspace-write sandbox means in-workspace commands run unprompted and the
 * boundary is enforced by the OS (seatbelt/landlock), not by an allowlist.
 */
export const CODEX_PERMISSION_MODES: readonly AgentPermissionMode[] = [
  mode("read-only", "Read only", "Never asks; the sandbox permits reads only, so writes fail", "ask"),
  mode("workspace-write", "Workspace write", "Runs commands inside the workspace without asking; escalates outside it", "auto"),
  mode("untrusted", "Untrusted", "Only trusted commands run without asking; anything else escalates"),
  mode("full-access", "Full access", "Never asks; full filesystem and network access", "full"),
]

export type CodexPermissionSettings = {
  approvalPolicy: "untrusted" | "on-failure" | "on-request" | "never"
  sandbox: "read-only" | "workspace-write" | "danger-full-access"
}

export const CODEX_SETTINGS: Record<string, CodexPermissionSettings> = {
  "read-only": { approvalPolicy: "never", sandbox: "read-only" },
  "workspace-write": { approvalPolicy: "on-request", sandbox: "workspace-write" },
  untrusted: { approvalPolicy: "untrusted", sandbox: "workspace-write" },
  "full-access": { approvalPolicy: "never", sandbox: "danger-full-access" },
}

/** The rung a Codex thread runs under before anyone has chosen. */
export const DEFAULT_CODEX_MODE = "workspace-write"

export const codexSettingsFor = (modeId: string | undefined): CodexPermissionSettings =>
  CODEX_SETTINGS[modeId ?? ""] ?? CODEX_SETTINGS[DEFAULT_CODEX_MODE]!

/**
 * `turn/start` takes a STRUCTURED sandbox policy while `thread/start` takes the
 * bare slug. Same concept, two encodings — which is exactly the kind of split
 * that let the two call sites drift out of agreement before, so the conversion
 * lives here rather than being written out at each one.
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
