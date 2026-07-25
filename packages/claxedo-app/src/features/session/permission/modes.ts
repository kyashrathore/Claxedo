import type { HarnessId } from "@/platform/identity/session-ref"
import {
  HARNESS_LABELS,
  PERMISSION_MECHANISMS,
  type ClaudeSdkPermissionMode,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
} from "@/features/session/permission/mechanisms"

/**
 * Permission modes: ONE Claxedo-owned mode, plus whatever the selected harness
 * itself offers.
 *
 * This replaced an earlier design that invented five abstract modes
 * (manual/auto/full/plan/harness) and mapped each onto every harness. That
 * mapping was lossy in ways no amount of care fixes: `cursor-sdk` has no
 * permission surface at all, `pi` cannot restrict a tool ahead of time, Codex has
 * no plan mode, and ACP mode ids are an open `string` by spec so a "mapping" was
 * really a guess resolved at runtime. Offering five modes everywhere meant
 * claiming capabilities that did not exist.
 *
 * So: Claxedo ships exactly one mode of its own — Auto — which it implements
 * itself and can therefore honour on every harness. Everything else in the picker
 * comes from the harness, in the harness's OWN words, and is empty (with a
 * reason) when the harness has nothing to offer. Nothing is invented.
 */

/**
 * Tool tiers Claxedo's own Auto mode uses. Shared with permission-auto-respond.
 *
 * TWO VOCABULARIES land in the same `permission` field and both must be covered:
 *   - opencode sends its own permission keys (`read`, `glob`, `grep`, `bash`, …).
 *   - ACP harnesses send the protocol's `ToolKind` (`read`, `edit`, `delete`,
 *     `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, `other`).
 * The names that appear in both (`read`, `edit`) mean the same thing, so they are
 * safe to share; the rest are additive. Anything unlisted asks.
 */
export const SAFE_READ_PERMISSIONS = ["read", "glob", "grep", "list", "lsp"] as const

/** ACP `ToolKind` values that are safe, beyond the ones opencode already names. */
export const ACP_SAFE_TOOL_KINDS = ["search", "think"] as const

/**
 * ACP `ToolKind` values that must always reach the user. `delete` and `move` are
 * deliberately NOT grouped with `edit`: a destructive file operation must not ride
 * along with an in-project edit. `other` asks because it is the protocol's
 * catch-all — see the module note on failing safe.
 */
export const ACP_DANGER_TOOL_KINDS = ["delete", "move", "execute", "fetch", "switch_mode", "other"] as const
export const IN_PROJECT_WRITE_PERMISSIONS = ["edit", "todowrite"] as const
export const INTERACTIVE_PERMISSIONS = ["question"] as const
export const DANGER_GATED_PERMISSIONS = [
  "bash",
  "webfetch",
  "websearch",
  "external_directory",
  "task",
  "skill",
  "doom_loop",
] as const

/**
 * An ACP-advertised mode. Structurally the protocol's `SessionMode`, redeclared
 * so the app layer does not depend on the ACP SDK.
 *
 * NAMING — the protocol calls these "session modes" and that channel is generic:
 * this repo also matches AGENT names against the same list (`acp/session.ts`).
 * Only the ones surfaced in this picker are permission modes.
 */
export type AdvertisedPermissionMode = {
  id: string
  name: string
  description?: string
}

/** What the user picked. */
export type PermissionSelection =
  | { kind: "claxedo-auto" }
  | { kind: "harness"; modeId: string }

export const CLAXEDO_AUTO_ID = "claxedo-auto"

/** Auto is the default, and the only mode Claxedo implements itself. */
export const DEFAULT_PERMISSION_SELECTION: PermissionSelection = { kind: "claxedo-auto" }

/** The concrete call Claxedo makes for a given option. */
export type PermissionModeDelivery =
  | {
      kind: "claxedo-auto-answer"
      autoAnswer: readonly string[]
      /**
       * How to answer. `always` asks the harness to PERSIST the grant, so the
       * same permission is answered once and never asked again; `once` re-answers
       * every occurrence forever.
       */
      respondWith: "once" | "always"
    }
  | { kind: "opencode-config-rules"; rules: Record<string, "ask" | "allow" | "deny"> }
  | { kind: "acp-set-session-mode"; modeId: string }
  | {
      kind: "claude-sdk-permission-mode"
      permissionMode: ClaudeSdkPermissionMode
      allowDangerouslySkipPermissions?: true
    }
  | { kind: "codex-approval-policy"; approvalPolicy: CodexApprovalPolicy; sandbox: CodexSandboxMode }

export type PermissionModeOption = {
  id: string
  name: string
  description?: string
  origin: "claxedo" | "harness"
  /** A condition the user must know about, shown alongside the option. */
  caveat?: string
  /** How this option reaches the harness. Drives the per-item info. */
  delivery: PermissionModeDelivery
}

/** Permissions Claxedo answers itself when it has to do the work locally. */
export const CLAXEDO_AUTO_ANSWERS = [
  ...SAFE_READ_PERMISSIONS,
  ...ACP_SAFE_TOOL_KINDS,
  ...INTERACTIVE_PERMISSIONS,
  ...IN_PROJECT_WRITE_PERMISSIONS,
] as const

/**
 * Answer with `always`, not `once`.
 *
 * ACP exposes `allow_always` as a `PermissionOptionKind`, and the harness persists
 * it — so a safe permission is answered ONE time and never asked about again.
 * Answering `once` instead means the harness keeps asking forever and Claxedo keeps
 * silently replying, which looks identical to the user but leaves the permission
 * ungranted and dies the moment Claxedo is not there to answer.
 *
 * Scope is the harness's to decide: the option it advertises for `allow_always`
 * carries whatever granularity it intends (this tool, this command pattern, this
 * directory). Claxedo does not widen it.
 */
const CLAXEDO_LOCAL_AUTO: PermissionModeDelivery = {
  kind: "claxedo-auto-answer",
  autoAnswer: CLAXEDO_AUTO_ANSWERS,
  respondWith: "always",
}

/**
 * How Auto is delivered on a given harness.
 *
 * Auto has ONE meaning — approve reads and in-project edits, ask before anything
 * risky — but it is NOT delivered the same way everywhere, because delegating to a
 * harness that natively implements that intent is strictly better than Claxedo
 * answering prompts after the fact:
 *
 *   - a native mode is ENFORCED by the harness, so the risky action is never even
 *     attempted, and it survives Claxedo disconnecting;
 *   - Claude's own `auto` runs a model classifier, which judges a command far
 *     more precisely than Claxedo's fixed allowlist can.
 *
 * Claxedo answers locally only where the harness offers nothing. ACP harnesses are
 * deliberately in that group: their mode ids are open strings, and picking one by
 * guessing at its id is exactly the mistake this design removed. The user can
 * still select any advertised ACP mode explicitly.
 *
 * There is no silent fallback. If a delivery fails at runtime (e.g. the model does
 * not support Claude's auto mode), that surfaces as an error rather than quietly
 * dropping to local answering — otherwise the user would believe a classifier is
 * gating their commands when only an allowlist is.
 */
function autoDelivery(harness: HarnessId): { delivery: PermissionModeDelivery; caveat?: string } {
  const mechanism = PERMISSION_MECHANISMS[harness]
  switch (mechanism.kind) {
    case "opencode-config-rules":
      return {
        delivery: {
          kind: "opencode-config-rules",
          // Every key, every time: `Config.update` deep-merges and
          // `Permission.evaluate` takes the LAST matching rule in key order, so a
          // partial patch would let a stale rule outrank `*`.
          rules: {
            "*": "ask",
            ...Object.fromEntries(SAFE_READ_PERMISSIONS.map((key) => [key, "allow" as const])),
            ...Object.fromEntries(INTERACTIVE_PERMISSIONS.map((key) => [key, "allow" as const])),
            ...Object.fromEntries(IN_PROJECT_WRITE_PERMISSIONS.map((key) => [key, "allow" as const])),
            ...Object.fromEntries(DANGER_GATED_PERMISSIONS.map((key) => [key, "ask" as const])),
          },
        },
      }

    case "claude-sdk-permission-mode":
      return {
        delivery: { kind: "claude-sdk-permission-mode", permissionMode: "auto" },
        caveat: "Uses Claude's own classifier; needs a model that supports auto mode",
      }

    case "codex-approval-policy":
      return {
        delivery: { kind: "codex-approval-policy", approvalPolicy: "on-request", sandbox: "workspace-write" },
      }

    case "acp-session-mode":
      return {
        delivery: CLAXEDO_LOCAL_AUTO,
        caveat: "Claxedo grants these on first use; the harness enforces them after that",
      }

    case "claxedo-answers-locally":
    case "none":
      return {
        delivery: CLAXEDO_LOCAL_AUTO,
        // Pi has no persistence to grant into, so here it really is every time.
        caveat: "Claxedo answers these prompts on your behalf",
      }
  }
}

/**
 * Claxedo's single built-in mode, resolved for a harness.
 *
 * A function rather than a constant because the DELIVERY differs per harness even
 * though the intent does not — see `autoDelivery`.
 */
export function claxedoAutoMode(harness: HarnessId): PermissionModeOption {
  const { delivery, caveat } = autoDelivery(harness)
  return {
    id: CLAXEDO_AUTO_ID,
    name: "Auto",
    description: "Approve reads and edits, ask before anything risky",
    origin: "claxedo",
    ...(caveat ? { caveat } : {}),
    delivery,
  }
}

/**
 * Claude Agent SDK modes, with the SDK's OWN descriptions copied verbatim from its
 * `PermissionMode` doc comment (sdk.d.ts), in the order the SDK documents them.
 *
 * The union itself is locked to the SDK at compile time by
 * `agent-sdk-runtime/src/harnesses/claude/permission-mode-parity.ts`.
 */
const CLAUDE_SDK_MODES: readonly PermissionModeOption[] = [
  {
    id: "default",
    name: "Default",
    description: "Standard behavior, prompts for dangerous operations",
    origin: "harness",
    delivery: { kind: "claude-sdk-permission-mode", permissionMode: "default" },
  },
  {
    id: "acceptEdits",
    name: "Accept edits",
    description: "Auto-accept file edit operations",
    origin: "harness",
    delivery: { kind: "claude-sdk-permission-mode", permissionMode: "acceptEdits" },
  },
  {
    id: "auto",
    name: "Claude auto",
    description: "Use a model classifier to approve/deny permission prompts",
    origin: "harness",
    // Three separate things can withdraw this mode, none of them visible from a
    // mode list: `ModelInfo.supportsAutoMode` is per-model, a `disableAutoMode`
    // setting turns it off wholesale, and an org `org_max_permission` ceiling of
    // "ask" forces a prompt anyway.
    caveat: "Needs a model that supports auto mode; org policy can still force prompts",
    delivery: { kind: "claude-sdk-permission-mode", permissionMode: "auto" },
  },
  {
    id: "plan",
    name: "Plan",
    description: "Planning mode, no actual tool execution",
    origin: "harness",
    delivery: { kind: "claude-sdk-permission-mode", permissionMode: "plan" },
  },
  {
    id: "dontAsk",
    name: "Don't ask",
    description: "Don't prompt for permissions, deny if not pre-approved",
    origin: "harness",
    delivery: { kind: "claude-sdk-permission-mode", permissionMode: "dontAsk" },
  },
  {
    id: "bypassPermissions",
    name: "Bypass permissions",
    description: "Bypass all permission checks",
    origin: "harness",
    caveat: "Disables every permission check for the session",
    delivery: {
      kind: "claude-sdk-permission-mode",
      permissionMode: "bypassPermissions",
      // The SDK requires this alongside the mode as a deliberate-intent guard.
      allowDangerouslySkipPermissions: true,
    },
  },
]

/**
 * Codex app-server policies. Codex has no mode list — these are its documented
 * `approval_policy` values, each paired with the sandbox that makes it coherent.
 */
const CODEX_APP_SERVER_MODES: readonly PermissionModeOption[] = [
  {
    id: "untrusted",
    name: "Untrusted",
    description: "Only trusted commands run without asking; anything else escalates",
    origin: "harness",
    delivery: { kind: "codex-approval-policy", approvalPolicy: "untrusted", sandbox: "workspace-write" },
  },
  {
    id: "on-request",
    name: "On request",
    description: "The model decides when to ask you for approval",
    origin: "harness",
    delivery: { kind: "codex-approval-policy", approvalPolicy: "on-request", sandbox: "workspace-write" },
  },
  {
    id: "read-only",
    name: "Read only",
    description: "Never asks; the sandbox permits reads only, so writes fail",
    origin: "harness",
    // Not a plan mode: Codex still ATTEMPTS writes and the sandbox rejects them.
    caveat: "Codex has no plan mode — writes are attempted and fail rather than withheld",
    delivery: { kind: "codex-approval-policy", approvalPolicy: "never", sandbox: "read-only" },
  },
  {
    id: "never",
    name: "Never ask",
    description: "Never asks; failures are returned to the model instead",
    origin: "harness",
    caveat: "Full filesystem access with no confirmation",
    delivery: { kind: "codex-approval-policy", approvalPolicy: "never", sandbox: "danger-full-access" },
  },
]

export type HarnessPermissionModes = {
  modes: readonly PermissionModeOption[]
  /** Set when `modes` is empty: why this harness offers nothing to pick. */
  unavailable?: string
}

/**
 * The selected harness's own permission modes.
 *
 * Returns an empty list plus a reason rather than a fabricated set whenever the
 * harness genuinely has nothing — the picker then shows Claxedo's Auto alone,
 * which is the honest outcome.
 */
export function harnessPermissionModes(input: {
  harness: HarnessId
  /** Advertised modes for THIS session. Required for ACP harnesses. */
  advertisedModes?: readonly AdvertisedPermissionMode[]
}): HarnessPermissionModes {
  const mechanism = PERMISSION_MECHANISMS[input.harness]
  const label = HARNESS_LABELS[input.harness]

  switch (mechanism.kind) {
    case "none":
      return { modes: [], unavailable: `${label} offers no permission modes — ${mechanism.reason}` }

    case "claxedo-answers-locally":
      return {
        modes: [],
        unavailable: `${label} has no permission settings of its own, so only Claxedo's Auto applies`,
      }

    case "opencode-config-rules":
      // opencode's mechanism is per-tool config rules, not a mode list. Claxedo's
      // Auto expresses the useful policy; inventing "modes" here would be naming
      // things opencode does not have.
      return { modes: [], unavailable: `${label} uses per-tool config rules rather than modes` }

    case "claude-sdk-permission-mode":
      return { modes: CLAUDE_SDK_MODES }

    case "codex-approval-policy":
      return { modes: CODEX_APP_SERVER_MODES }

    case "acp-session-mode": {
      const advertised = input.advertisedModes
      if (advertised === undefined) {
        return { modes: [], unavailable: `Waiting for ${label} to report its modes` }
      }
      if (advertised.length === 0) {
        return { modes: [], unavailable: `${label} reported no modes for this session` }
      }
      return {
        modes: advertised.map((mode) => ({
          id: mode.id,
          // The agent's own name and description — never a Claxedo label, because
          // `SessionModeId` is an open string and we cannot know what an id means.
          name: mode.name,
          ...(mode.description ? { description: mode.description } : {}),
          origin: "harness" as const,
          delivery: { kind: "acp-set-session-mode" as const, modeId: mode.id },
        })),
      }
    }
  }
}

/** Everything the picker shows: Claxedo's Auto first, then the harness's own. */
export function permissionModeOptions(input: {
  harness: HarnessId
  advertisedModes?: readonly AdvertisedPermissionMode[]
}): { claxedo: readonly PermissionModeOption[]; harness: HarnessPermissionModes } {
  return { claxedo: [claxedoAutoMode(input.harness)], harness: harnessPermissionModes(input) }
}

/** Resolve a selection to the option it refers to, or undefined if it is stale. */
export function findPermissionModeOption(input: {
  selection: PermissionSelection
  harness: HarnessId
  advertisedModes?: readonly AdvertisedPermissionMode[]
}): PermissionModeOption | undefined {
  const selection = input.selection
  if (selection.kind === "claxedo-auto") return claxedoAutoMode(input.harness)
  // Bound to a local before the callback: TypeScript discards narrowing on a
  // property access once it is read inside a closure.
  const modeId = selection.modeId
  return harnessPermissionModes(input).modes.find((mode) => mode.id === modeId)
}
