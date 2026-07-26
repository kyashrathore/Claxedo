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
 * not documentation. Re-derived 2026-07-25 against the versions INSTALLED in
 * `packages/agent-sdk-runtime/node_modules`, which is the only thing that binds:
 *
 *   @anthropic-ai/claude-agent-sdk  0.3.215
 *   @cursor/sdk                     1.0.23
 *   @agentclientprotocol/sdk        1.2.1
 *
 * That re-derivation is why the version numbers are written down. The previous
 * pass described the ACP SDK as 0.14.1 and then 0.16.1 — both wrong, and both
 * wrong in ways that changed what the table claimed was possible — and asserted
 * `cursor-sdk` had no permission surface when two fields for one sit in the
 * installed declarations. A mechanism claim with no version attached is a claim
 * nobody can re-check.
 *
 * A SECOND distinction runs through these entries and is easy to lose: whether a
 * channel EXISTS is not whether Claxedo USES it. Several of these are real,
 * documented, installed — and unwired on our side. Each says which it is,
 * because "the harness cannot do this" and "we never send it" look identical
 * from the UI and have completely different fixes.
 */
export type PermissionMechanism =
  /**
   * `opencode` — a per-session `PermissionRuleset`, written with
   * `client.session.update({ permission })` (`PATCH /session/:sessionID`).
   *
   * NOT `PATCH /config`, which is where this started and which was rejected after
   * reading the engine. Three findings, each independently disqualifying:
   *
   *  1. The config HTTP handler calls `markInstanceForDisposal` UNCONDITIONALLY —
   *     every request, even a no-op payload
   *     (`server/routes/instance/httpapi/handlers/config.ts`). Disposal runs inside
   *     the same request, `Effect.uninterruptible`, with no check for an active turn.
   *  2. The disposer set includes `SessionRunState`, whose scope finalizer cancels
   *     every live turn — `Fiber.interrupt` on the turn's fiber
   *     (`packages/opencode/src/session/run-state.ts` and the turn-execution module
   *     beside it in `src/effect/`) — the same path as the user pressing Stop. The
   *     prompt returns 200 with a partial message stamped `AbortError{aborted:true}`,
   *     so changing a dropdown is indistinguishable from the user aborting. Pending
   *     permission prompts get `RejectedError`, and MCP clients and LSP servers die
   *     with it.
   *  3. `Config.update` writes `<instance dir>/config.json`, and NO config loader
   *     reads that path — the loader only walks `opencode.json`/`opencode.jsonc`,
   *     `.opencode/`, `$OPENCODE_CONFIG`, and the GLOBAL config dir. So it appears
   *     to pay the full restart cost and change nothing.
   *
   * The session route has none of that: no disposal in its handler, and the ruleset
   * is projected into SQLite, so it survives an engine restart AND an app restart —
   * unlike `reply: "always"`, which is a plain in-memory array.
   */
  | { kind: "opencode-session-ruleset" }
  /**
   * `claude-sdk` — the Claude Agent SDK's own enumerated `PermissionMode`
   * (`sdk.d.ts:2065`), settable as `options.permissionMode` at query time and via
   * `Query.setPermissionMode()` mid-session (`sdk.d.ts:2273`). This is the ONLY
   * harness whose permission modes are a real closed union.
   *
   * EXISTS BUT UNWIRED. Our driver sets neither: `harnesses/claude/driver.ts:134`
   * passes `canUseTool` and nothing else, so today every decision is Claxedo
   * answering a callback per tool call. The earlier version of this comment
   * described `permissionMode` as how Claxedo delivers Auto, which was a
   * description of the SDK, not of us.
   *
   * Two constraints the mode list alone does not show, both read off the same
   * declarations:
   *
   *  - `bypassPermissions` additionally requires `allowDangerouslySkipPermissions`
   *    (`sdk.d.ts:2063`). The SDK gates its own escape hatch behind a second,
   *    separately-named flag; the delivery for that mode carries it explicitly
   *    rather than letting a mode id alone turn every check off.
   *  - `disallowedTools` (`sdk.d.ts:1368`) removes tools from the model's context
   *    so they "cannot be used, EVEN IF they would otherwise be allowed". That is
   *    the only un-bypassable control on any harness in this table: it outranks
   *    every mode above, including `bypassPermissions`. It is a floor, not a mode
   *    — orthogonal to this union, which is why it is not a variant of it — and
   *    nothing in Claxedo sets it yet.
   */
  | { kind: "claude-sdk-permission-mode" }
  /**
   * `claude-acp` / `codex-acp` / `cursor-acp` — ACP, which as of
   * `@agentclientprotocol/sdk` 1.2.1 has TWO channels, not one:
   *
   *  1. `SessionModeState` — `currentModeId` + `availableModes`, set with
   *     `session/set_mode` (`schema/types.gen.d.ts:2587`). The older channel and
   *     still the one agents actually implement.
   *  2. `configOptions: SessionConfigOption[]` + `session/set_config_option`
   *     (`types.gen.d.ts:2643`, `acp.d.ts:1119`), negotiated through
   *     `SessionConfigOptionsCapabilities` (`types.gen.d.ts:4246`). Newer and
   *     more general — an option carries a `category` of `"mode" | "model" |
   *     "model_config" | "thought_level" | string`.
   *
   * Do NOT read `category` as authority over behaviour. The spec is explicit that
   * it exists "for UX purposes (keyboard shortcuts, icons, placement)" and "MUST
   * NOT be required for correctness" (`types.gen.d.ts:2680-2685`). It tells you
   * where to draw a control, never what selecting it does.
   *
   * `SessionModeId` is an open `string` in both channels, so the available set is
   * discovered per session and never assumed.
   *
   * EXISTS BUT UNWIRED, and this is the cause of the picker's permanent
   * "Waiting for … to report its modes": `harnesses/acp/index.ts:1311` hardcodes
   * `modes: []`, and nothing anywhere reads `configOptions` in the ACP sense.
   * (`readHarnessCapabilities().configOptions` is a DIFFERENT, Claxedo-owned flag
   * about model probing — same word, unrelated concept. Do not wire one to the
   * other.)
   *
   * The channel is also shared, not permission-specific: `acp/session.ts` matches
   * AGENT names against the same `availableModes` list. Anything that writes a
   * mode here has to reckon with the agent selector writing to the same slot.
   */
  | { kind: "acp-session-mode" }
  /**
   * `codex-app-server` — `approvalPolicy` + `approvalsReviewer` + sandbox fields
   * on `thread/start` and `turn/start`. Untyped JSON-RPC params.
   *
   * EXISTS AND IS SENT, but pinned: `harnesses/codex/driver.ts:166` and again at
   * `:246` hardcode `on-request` / `"user"` / `workspace-write` on both call
   * sites. So unlike the two above, the wire carries a real policy every turn —
   * it is just always the same one, and the user cannot reach it. Any change here
   * must edit BOTH sites or a turn will silently disagree with its thread.
   */
  | { kind: "codex-approval-policy" }
  /**
   * `cursor-sdk` — two independent booleans on `LocalAgentOptions`
   * (`@cursor/sdk/dist/esm/options.d.ts`):
   *
   *  - `sandboxOptions: { enabled: boolean }` (`:132`, shape at `:63`)
   *  - `autoReview?: boolean` (`:115`) — "select the classifier-backed Auto mode
   *    WHENEVER THE CONNECTED BACKEND HAS the Auto-review classifier feature
   *    enabled". A request, not a guarantee: a client cannot tell from the option
   *    whether it took effect, so any UI offering it has to say so.
   *
   * This entry previously read `{ kind: "none" }` — "genuinely NOTHING", asserted
   * against this same installed version. It was wrong, and it is the reason this
   * table now cites file and line for every claim.
   *
   * EXISTS AND IS UNWIRED: our driver passes `local: { cwd }` at
   * `harnesses/cursor/driver.ts:79` and `local: { force }` at `:108`, neither
   * field among them.
   *
   * CREATION-TIME ONLY, which shapes what the picker may promise. Both fields sit
   * on `LocalAgentOptions` (consumed by `Agent.create`); the per-send
   * `LocalSendOptions` (`options.d.ts:151`) carries only `force` and
   * `customTools`. So there is no mid-session write for these — changing one
   * means the NEXT agent, not the next turn.
   */
  | { kind: "cursor-local-agent-options" }
  /**
   * `pi` — no policy surface whatsoever. Pi emits `permission: <tool>` in-band
   * (harnesses/pi/index.ts) and Claxedo answers locally. Nothing is enforced by
   * the harness; Claxedo just replies fast.
   */
  | { kind: "claxedo-answers-locally" }

export const PERMISSION_MECHANISMS: Record<HarnessId, PermissionMechanism> = {
  opencode: { kind: "opencode-session-ruleset" },
  "claude-sdk": { kind: "claude-sdk-permission-mode" },
  "claude-acp": { kind: "acp-session-mode" },
  "codex-acp": { kind: "acp-session-mode" },
  "cursor-acp": { kind: "acp-session-mode" },
  "codex-app-server": { kind: "codex-approval-policy" },
  "cursor-sdk": { kind: "cursor-local-agent-options" },
  pi: { kind: "claxedo-answers-locally" },
}

/**
 * There is deliberately no `none` mechanism any more.
 *
 * It existed for `cursor-sdk` alone and was wrong. Removing the variant rather
 * than leaving it unused is the point: an empty case invites the next harness
 * with a surface nobody has looked for yet to be filed under "has nothing",
 * which is exactly how the cursor claim survived. `pi` is the one harness that
 * genuinely offers no policy surface, and it says so specifically
 * (`claxedo-answers-locally`) rather than generically.
 */

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
   * "Use a model classifier to approve/deny permission prompts" — the SDK's own
   * words (`sdk.d.ts:2063`). Distinct from `acceptEdits`, which covers edits only
   * and still prompts for Bash/MCP.
   *
   * This is NOT how Claxedo's own Auto is delivered on `claude-sdk`, though an
   * earlier comment here said so. Claxedo answers the `canUseTool` callback
   * against a fixed allowlist; no classifier is involved and `permissionMode` is
   * never set. Offering this mode is therefore offering something strictly
   * different from Auto, not a synonym for it.
   */
  | "auto"

/** Codex `approval_policy` values (JSON-RPC, untyped upstream). */
export type CodexApprovalPolicy = "untrusted" | "on-request" | "never"

/** Codex `sandbox_mode` values (JSON-RPC, untyped upstream). */
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access"

/**
 * The two `LocalAgentOptions` fields that govern what a local Cursor agent may do
 * without asking. Both are plain booleans upstream; naming the pair keeps them
 * together, because they are independent and a UI that sets one without stating
 * the other is describing half a policy.
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
