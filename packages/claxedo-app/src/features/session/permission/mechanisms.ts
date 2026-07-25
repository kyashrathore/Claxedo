import { type HarnessId } from "@/platform/identity/session-ref"

/**
 * How each harness can be told about permissions.
 *
 * Keyed on the canonical `HarnessId` (all EIGHT ids), not on a provider name.
 * That distinction is the whole point: `claude-acp` and `claude-sdk` are the same
 * vendor but have completely unrelated permission mechanisms, and an earlier
 * version of this matrix collapsed them — which also silently dropped
 * `cursor-sdk`. `session-ref.ts` carries a comment about these harness lists
 * having drifted before; a `Record<HarnessId, …>` makes a missing entry a compile
 * error instead.
 *
 * Every entry below was read off the actual dependency types or driver source,
 * not documentation:
 */
export type PermissionMechanism =
  /**
   * `opencode` — typed rules in the project config, wildcard-matched.
   * Written with `client.config.update()` (`PATCH /config`).
   */
  | { kind: "opencode-config-rules" }
  /**
   * `claude-sdk` — the Claude Agent SDK's own enumerated `PermissionMode`, set via
   * `options.permissionMode` at query time and `Query.setPermissionMode()`
   * mid-session (`@anthropic-ai/claude-agent-sdk` coreTypes/runtimeTypes).
   * This is the ONLY harness whose permission modes are a real closed union.
   */
  | { kind: "claude-sdk-permission-mode" }
  /**
   * `claude-acp` / `codex-acp` / `cursor-acp` — ACP `availableModes` +
   * `session/set_mode`. `SessionModeId` is an open `string` by spec, so the
   * available set is discovered per session and never assumed.
   */
  | { kind: "acp-session-mode" }
  /**
   * `codex-app-server` — `approvalPolicy` + sandbox fields on `thread/start` and
   * `turn/start` (harnesses/codex/driver.ts). Untyped JSON-RPC params; currently
   * hardcoded to `on-request` / `workspace-write`.
   */
  | { kind: "codex-approval-policy" }
  /**
   * `pi` — no policy surface whatsoever. Pi emits `permission: <tool>` in-band
   * (harnesses/pi/index.ts) and Claxedo answers locally. Nothing is enforced by
   * the harness; Claxedo just replies fast.
   */
  | { kind: "claxedo-answers-locally" }
  /**
   * `cursor-sdk` — genuinely NOTHING. The Cursor SDK exposes no permission
   * surface: its `mode` is `AgentModeOption = "agent" | "plan"` (an execution
   * mode) and `local.force` is a crash-recovery flag for wedged runs. Verified
   * against @cursor/sdk 1.0.23 type declarations.
   */
  | { kind: "none"; reason: string }

export const PERMISSION_MECHANISMS: Record<HarnessId, PermissionMechanism> = {
  opencode: { kind: "opencode-config-rules" },
  "claude-sdk": { kind: "claude-sdk-permission-mode" },
  "claude-acp": { kind: "acp-session-mode" },
  "codex-acp": { kind: "acp-session-mode" },
  "cursor-acp": { kind: "acp-session-mode" },
  "codex-app-server": { kind: "codex-approval-policy" },
  "cursor-sdk": {
    kind: "none",
    reason: "the Cursor SDK exposes no permission controls (only an agent/plan execution mode)",
  },
  pi: { kind: "claxedo-answers-locally" },
}

/**
 * The Claude Agent SDK's `PermissionMode`, mirrored structurally so this package
 * does not take a dependency on the SDK.
 *
 * `packages/agent-sdk-runtime/src/harnesses/claude/permission-mode-parity.test.ts`
 * asserts at TYPE level that this stays identical to the SDK's own union, so an
 * SDK upgrade that adds or renames a mode fails to compile rather than silently
 * leaving this list stale.
 */
export type ClaudeSdkPermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  /**
   * The classifier-gated mode Anthropic documents as "auto mode": safe tiers are
   * approved automatically and only genuinely risky actions escalate. Claxedo's
   * Auto maps here — NOT to `acceptEdits`, which covers edits only and still
   * prompts for Bash/MCP.
   */
  | "auto"

/** Codex `approval_policy` values (JSON-RPC, untyped upstream). */
export type CodexApprovalPolicy = "untrusted" | "on-request" | "never"

/** Codex `sandbox_mode` values (JSON-RPC, untyped upstream). */
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access"

export const HARNESS_LABELS: Record<HarnessId, string> = {
  opencode: "opencode",
  "claude-acp": "Claude (ACP)",
  "claude-sdk": "Claude (SDK)",
  "codex-acp": "Codex (ACP)",
  "codex-app-server": "Codex (SDK)",
  "cursor-acp": "Cursor (ACP)",
  "cursor-sdk": "Cursor (SDK)",
  pi: "Pi",
}
