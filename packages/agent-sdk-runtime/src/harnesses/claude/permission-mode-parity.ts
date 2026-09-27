import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk"

/**
 * Compile-time lock between the Claude Agent SDK's `PermissionMode` union and
 * the ids the driver forwards as `permissionMode`.
 *
 * The contract's `HARNESS_TABLE.claude.permissionModes` cannot name the SDK
 * type (the contract package depends on nothing), so this mirror is the typed
 * copy and the parity test holds the table's ids to it. The assertions live in
 * production source because test files are excluded from the package
 * typecheck.
 */
export const CLAUDE_SDK_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
] as const

export type ClaudeSdkPermissionModeMirror = (typeof CLAUDE_SDK_PERMISSION_MODES)[number]

/** Sound because the mirror above is asserted equal to the SDK union below. */
export function isClaudeSdkPermissionMode(value: string | undefined): value is ClaudeSdkPermissionModeMirror {
  return !!value && (CLAUDE_SDK_PERMISSION_MODES as readonly string[]).includes(value)
}

/** `never` unless the mirror covers every SDK mode. */
type MirrorCoversSdk = Exclude<PermissionMode, ClaudeSdkPermissionModeMirror> extends never ? true : false
/** `never` unless every mirrored mode is a real SDK mode. */
type SdkCoversMirror = Exclude<ClaudeSdkPermissionModeMirror, PermissionMode> extends never ? true : false

/**
 * `true & true` is `true`; if either direction fails it becomes `never` and this
 * initialiser is a type error. Exported so the value is used and cannot be
 * dropped as dead code.
 */
export const CLAUDE_SDK_PERMISSION_MODE_PARITY: MirrorCoversSdk = true
/** Fails to compile if the mirror ever names a mode the SDK dropped. */
type _SdkCoversMirrorParity = SdkCoversMirror extends true ? true : never
const _sdkCoversMirror: _SdkCoversMirrorParity = true
void _sdkCoversMirror

/**
 * Guards against the degenerate case where `PermissionMode` resolves to `any`
 * (bad module resolution), which would make both conditionals `boolean` and let
 * the parity constant pass vacuously. A genuine union is NOT assignable from an
 * arbitrary string.
 */
type SdkModeIsNotAny = string extends PermissionMode ? false : true
export const CLAUDE_SDK_PERMISSION_MODE_IS_A_REAL_UNION: SdkModeIsNotAny = true
