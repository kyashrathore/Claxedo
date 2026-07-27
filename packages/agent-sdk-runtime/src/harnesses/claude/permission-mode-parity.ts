import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk"

/**
 * Compile-time lock between the Claude Agent SDK's `PermissionMode` union and the
 * copy claxedo-app carries.
 *
 * WHY A PRODUCTION MODULE AND NOT A TEST — this package's tsconfig excludes
 * `src/**\/*.test.ts` from the typecheck, so a type-level assertion written in a
 * test file is silently dead: it compiles no matter what, and the test passes
 * while asserting nothing. (Verified by tripwire: deleting a mode from the mirror
 * AND inventing a fake one both produced zero errors from a .test.ts.) The
 * assertion therefore has to live in a file the compiler actually reads.
 *
 * The app cannot import the SDK type directly — claxedo-app must not depend on
 * `@anthropic-ai/claude-agent-sdk` — so it mirrors the union structurally in
 * `features/session/permission/mechanisms.ts` (`ClaudeSdkPermissionMode`) and
 * this file guarantees the mirror stays exact.
 *
 * If this file stops compiling, the SDK changed its permission modes: reconcile
 * BOTH the list below and `ClaudeSdkPermissionMode` in claxedo-app.
 */
export const CLAUDE_SDK_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  // First-class classifier-gated mode (the "auto mode" Anthropic documents):
  // auto-approves safe tiers and escalates only genuinely risky actions.
  //
  // Claxedo's Auto does NOT map here, despite what this comment used to claim.
  // Both implementations agree against it: `CLAUDE_PERMISSION_MODES` leaves this
  // id unlevelled and tags `acceptEdits` as the `auto` rung, and the ACP table
  // excludes a bare `auto` for the stated reason that a classifier can approve
  // COMMANDS as well as edits, while the rung means "edits yes, risk asks".
  // A classifier mode stays fully selectable — it is just not what gets chosen
  // for someone by default.
  "auto",
] as const

export type ClaudeSdkPermissionModeMirror = (typeof CLAUDE_SDK_PERMISSION_MODES)[number]

/** `never` unless the mirror covers every SDK mode. */
type MirrorCoversSdk = Exclude<PermissionMode, ClaudeSdkPermissionModeMirror> extends never ? true : false
/** `never` unless every mirrored mode is a real SDK mode. */
type SdkCoversMirror = Exclude<ClaudeSdkPermissionModeMirror, PermissionMode> extends never ? true : false

/**
 * `true & true` is `true`; if either direction fails it becomes `never` and this
 * initialiser is a type error. Exported so the value is used and cannot be
 * dropped as dead code.
 */
export const CLAUDE_SDK_PERMISSION_MODE_PARITY: MirrorCoversSdk & SdkCoversMirror = true

/**
 * Guards against the degenerate case where `PermissionMode` resolves to `any`
 * (bad module resolution), which would make both conditionals `boolean` and let
 * the parity constant pass vacuously. A genuine union is NOT assignable from an
 * arbitrary string.
 */
type SdkModeIsNotAny = string extends PermissionMode ? false : true
export const CLAUDE_SDK_PERMISSION_MODE_IS_A_REAL_UNION: SdkModeIsNotAny = true
