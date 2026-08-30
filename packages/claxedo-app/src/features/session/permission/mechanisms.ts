import { isAcpConnectionHarnessId, type BuiltinHarnessId, type HarnessId } from "@/platform/identity/session-ref"
import { harnessDisplayLabel } from "@/ui/harness-display"

/**
 * How each harness is told about permissions.
 *
 * Keyed on every built-in harness id so a missing entry is a compile error.
 * Operator-defined ACP connections use the protocol mechanism below.
 *
 * Claims below were read off the dependency types and driver source, against the
 * versions installed in `packages/agent-sdk-runtime/node_modules`:
 *
 *   @anthropic-ai/claude-agent-sdk  0.3.215
 *   @cursor/sdk                     1.0.23
 *   @agentclientprotocol/sdk        1.2.1
 *
 * The versions are recorded because a mechanism claim with no version attached
 * cannot be re-checked.
 *
 * Each entry names the mechanism and where the runtime delivers it. Whether a
 * channel exists and whether we use it are separate facts; both are stated,
 * because "the harness cannot do this" and "we never send it" look identical
 * from the UI and have different fixes.
 */
export type PermissionMechanism =
  /**
   * `opencode` — a per-session `PermissionRuleset`, written with
   * `client.session.update({ permission })` (`PATCH /session/:sessionID`).
   *
   * The app writes this directly; the runtime adapter has no `setPermissionMode`
   * for opencode, by design.
   *
   * Not `PATCH /config`, for three independent reasons:
   *
   *  1. The config handler calls `markInstanceForDisposal` unconditionally, even
   *     for a no-op payload
   *     (`server/routes/instance/httpapi/handlers/config.ts`). Disposal runs in
   *     the same request, `Effect.uninterruptible`, with no check for a live turn.
   *  2. The disposer set includes `SessionRunState`, whose finalizer interrupts
   *     every live turn's fiber — the same path as the user pressing Stop. The
   *     prompt returns 200 with a partial message stamped
   *     `AbortError{aborted:true}`, pending permission prompts get
   *     `RejectedError`, and MCP clients and LSP servers die with it.
   *  3. `Config.update` writes `<instance dir>/config.json`, which no config
   *     loader reads — the loader walks `opencode.json`/`opencode.jsonc`,
   *     `.opencode/`, `$OPENCODE_CONFIG` and the global config dir.
   *
   * The session route has none of that, and the ruleset is projected into SQLite
   * so it survives an engine restart and an app restart.
   */
  | { kind: "opencode-session-ruleset" }
  /**
   * `claude-sdk` — the SDK's enumerated `PermissionMode` (`sdk.d.ts:2065`), set
   * as `options.permissionMode` at query time. The only harness whose modes are
   * a real closed union.
   *
   * Delivered at `harnesses/claude/driver.ts:162`, alongside two related
   * controls:
   *
   *  - `bypassPermissions` additionally requires `allowDangerouslySkipPermissions`
   *    (`sdk.d.ts:2063`), sent only for that mode.
   *  - `settings.permissions.deny` carries `CLAUDE_DENY_FLOOR`. Per `sdk.d.ts:1368`
   *    these deny matching calls even when a mode would otherwise allow them, so
   *    the floor outranks every mode including `bypassPermissions`. It is
   *    orthogonal to the union, which is why it is not a variant of it.
   *
   * `Query.setPermissionMode()` (`sdk.d.ts:2273`) exists for mid-turn changes and
   * is unused: it applies to a streaming-input query the driver does not hold
   * open between turns. A turn is one `query()` call, so `appliesFrom` is
   * `next-turn`.
   */
  | { kind: "claude-sdk-permission-mode" }
  /**
   * Operator-defined ACP connections, which as of
   * `@agentclientprotocol/sdk` 1.2.1 has two channels:
   *
   *  1. `configOptions: SessionConfigOption[]` + `session/set_config_option`
   *     (`types.gen.d.ts:2643`, `acp.d.ts:1119`), negotiated through
   *     `SessionConfigOptionsCapabilities` (`types.gen.d.ts:4246`). The newer and
   *     more general channel; an option carries a `category` of
   *     `"mode" | "model" | "model_config" | "thought_level" | string`.
   *  2. `SessionModeState` — `currentModeId` + `availableModes`, set with
   *     `session/set_mode` (`schema/types.gen.d.ts:2587`). Older, and still what
   *     most agents implement.
   *
   * `harnesses/acp/session.ts:440` prefers the first and falls back to the
   * second, matching on `category === "mode"` rather than `id === "mode"`.
   *
   * `category` is not authority over behaviour: the spec says it exists "for UX
   * purposes (keyboard shortcuts, icons, placement)" and "MUST NOT be required
   * for correctness" (`types.gen.d.ts:2680-2685`). It says where to draw a
   * control, never what selecting it does.
   *
   * `SessionModeId` is an open `string` in both channels, so the available set is
   * discovered per session and never assumed.
   *
   * The channel is shared, not permission-specific: `acp/session.ts` also matches
   * AGENT names against `availableModes`. Anything writing a mode here shares a
   * slot with the agent selector.
   */
  | { kind: "acp-session-mode" }
  /**
   * `codex-app-server` — `approvalPolicy` + `approvalsReviewer` + a sandbox
   * policy, over untyped JSON-RPC.
   *
   * Sent on every `turn/start` from the current selection
   * (`harnesses/codex/driver.ts:277`). `thread/start` uses `DEFAULT_CODEX_MODE`
   * because a thread is created before the user has chosen; since each turn
   * re-sends, the thread default cannot outlive the first turn.
   *
   * The two call sites use different encodings of the same concept —
   * `thread/start` takes the bare slug, `turn/start` a structured policy — so the
   * conversion lives in `codexSandboxPolicy` rather than at each site.
   */
  | { kind: "codex-approval-policy" }
  /**
   * `cursor-sdk` — two independent booleans on `LocalAgentOptions`
   * (`@cursor/sdk/dist/esm/options.d.ts`):
   *
   *  - `sandboxOptions: { enabled: boolean }` (`:132`, shape at `:63`)
   *  - `autoReview?: boolean` (`:115`) — selects the classifier-backed Auto-review
   *    mode "whenever the connected backend has the Auto-review classifier feature
   *    enabled". A request, not a guarantee: the SDK exposes no way to tell
   *    whether it took effect, so any UI offering it has to say so.
   *
   * Both are read by `Agent.create` and delivered at
   * `harnesses/cursor/driver.ts:110`. The per-send `LocalSendOptions`
   * (`options.d.ts:151`) carries only `force` and `customTools`, so there is no
   * mid-session write and the selection is keyed by directory — hence
   * `appliesFrom: "next-session"`.
   *
   * `force` is not mapped to a rung. It expires a wedged run after a crashed CLI:
   * a recovery flag, not a grant.
   */
  | { kind: "cursor-local-agent-options" }
  /**
   * `pi` — no policy surface, and none is needed.
   *
   * Pi's tools reach nothing real. `harnesses/pi/index.ts:176` defaults its
   * session env to `createVirtualSessionEnv()` — `just-bash`, a simulated shell
   * over an `InMemoryFs` — and `:303` records the placement as
   * `toolSandbox: { kind: "virtual" }`. A command mutates a JavaScript object;
   * there is no filesystem, process spawn or network to gate.
   *
   * The picker shows `SANDBOXED_NO_POLICY_REASON` and no options, the same shape
   * a harness that could not start gets: an option that cannot change anything
   * must not be offered.
   */
  | { kind: "sandboxed-no-policy" }

export const PERMISSION_MECHANISMS: Record<BuiltinHarnessId, PermissionMechanism> = {
  opencode: { kind: "opencode-session-ruleset" },
  "claude-sdk": { kind: "claude-sdk-permission-mode" },
  "codex-app-server": { kind: "codex-approval-policy" },
  "cursor-sdk": { kind: "cursor-local-agent-options" },
  pi: { kind: "sandboxed-no-policy" },
}

/**
 * There is no generic `none` mechanism. A harness with no policy surface says
 * why it has none — `sandboxed-no-policy` names the reason — so a harness with a
 * surface nobody has looked for yet cannot be filed under "has nothing".
 */

/**
 * The Claude Agent SDK's `PermissionMode`, mirrored structurally so this package
 * does not depend on the SDK.
 *
 * `packages/agent-sdk-runtime/src/harnesses/claude/permission-mode-parity.test.ts`
 * asserts at type level that this stays identical to the SDK's own union, so an
 * SDK upgrade that adds or renames a mode fails to compile rather than leaving
 * this list stale.
 */
export type ClaudeSdkPermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  /**
   * "Use a model classifier to approve/deny permission prompts" — the SDK's own
   * words (`sdk.d.ts:2063`). Distinct from `acceptEdits`, which covers edits only
   * and still prompts for Bash and MCP. This is the rung Claxedo's Auto resolves
   * to on `claude-sdk`.
   */
  | "auto"

/** Codex `approval_policy` values (JSON-RPC, untyped upstream). */
export type CodexApprovalPolicy = "untrusted" | "on-request" | "never"

/** Codex `sandbox_mode` values (JSON-RPC, untyped upstream). */
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access"

/**
 * The two `LocalAgentOptions` fields governing what a local Cursor agent may do
 * without asking. Both are plain booleans upstream; naming the pair keeps them
 * together, because they are independent and a UI that sets one without stating
 * the other describes half a policy.
 */
export type CursorLocalPermissionOptions = {
  /** `sandboxOptions.enabled` — run tool calls inside Cursor's sandbox. */
  sandbox: boolean
  /**
   * `autoReview` — ask for the classifier-backed Auto-review mode. Honoured only
   * if the connected backend has that feature enabled, and the SDK reports no way
   * to find out whether it did.
   */
  autoReview: boolean
}

export const HARNESS_LABELS: Record<BuiltinHarnessId, string> = {
  opencode: "opencode",
  "claude-sdk": "Claude (SDK)",
  "codex-app-server": "Codex (SDK)",
  "cursor-sdk": "Cursor (SDK)",
  pi: "Pi",
}

/**
 * Mechanism lookup for ANY harness identity. Operator-configured ACP
 * connections speak the generic ACP session-mode surface because the adapter
 * negotiates modes live from the agent; there is no per-vendor mechanism.
 */
export function permissionMechanism(harness: HarnessId): PermissionMechanism {
  const hit = (PERMISSION_MECHANISMS as Partial<Record<string, PermissionMechanism>>)[harness]
  if (hit) return hit
  if (isAcpConnectionHarnessId(harness)) return { kind: "acp-session-mode" }
  // Unknown non-ACP identities have no policy surface to describe; fail toward
  // the harness-owns-it mechanism rather than inventing one.
  return { kind: "acp-session-mode" }
}

/** Prose label for ANY harness identity ("Claude (SDK)", or the connection's slug label). */
export function harnessPermissionLabel(harness: HarnessId): string {
  return (HARNESS_LABELS as Partial<Record<string, string>>)[harness] ?? harnessDisplayLabel(harness)
}
