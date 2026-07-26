import type { HarnessId } from "@/platform/identity/session-ref"
import { HARNESS_LABELS, PERMISSION_MECHANISMS } from "@/features/session/permission/mechanisms"

/**
 * Permission modes, named by whoever enforces them.
 *
 * The harness's OWN modes whenever it reports some — its ids, its names, its
 * descriptions, fetched per session from the runtime, which reads them off the
 * installed SDK. Claxedo's own two options appear only where the harness has
 * nothing, and even those are named for what they do.
 *
 * There is deliberately no "Auto" here. Two earlier designs failed in the same
 * direction and this is the correction to both. The first invented five abstract
 * modes and mapped them onto every harness, naming capabilities that did not
 * exist. The second kept one Claxedo-owned "Auto" alongside the harness's modes
 * — better, but "Auto" still meant materially different things depending on the
 * harness (a persisted engine ruleset on one, Claxedo answering prompts
 * in-process on another) while wearing one word, and it sat next to the
 * harness's own modes with no way to tell which won.
 *
 * The rule that replaces both: a name the user reads must come from whoever
 * enforces the behaviour. Names we write can drift from what the harness does;
 * names the harness reports cannot.
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
 * What the user picked.
 *
 * `kind` records WHO owns the id, and it is not decoration: the same id string
 * can exist in both groups, and resolving a claxedo id against the harness's
 * list (or the reverse) would silently return the wrong option. Both carry a
 * plain `modeId` because neither set is closed — the harness's ids come off the
 * wire, and Claxedo's are matched by id for symmetry rather than special-cased.
 *
 * There is no module-level default constant. The default depends on what the
 * harness reported for THIS session, so it is a function — see
 * `defaultPermissionSelection`. A constant here was previously unreachable in
 * the running app while appearing to define its behaviour.
 */
export type PermissionSelection =
  | { kind: "claxedo"; modeId: string }
  | { kind: "harness"; modeId: string }

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
  | {
      kind: "opencode-session-ruleset"
      /**
       * ORDERED, and the order is load-bearing: `Permission.evaluate` takes the
       * LAST wildcard-matching rule, so the catch-all comes first and the specific
       * grants after it. This is an array rather than the `Record` this used to be
       * precisely because object key order is an implementation detail to rely on
       * and array order is not.
       *
       * Always the COMPLETE set, never a partial patch: the session handler MERGES
       * (`Permission.merge(current, incoming)`) rather than replacing, so a partial
       * update would leave a previous mode's rule still in the array and, being
       * earlier, still reachable by `findLast` only if the new set does not cover
       * the same permission. Sending every key makes the write order-independent.
       */
      ruleset: readonly { permission: string; pattern: string; action: "ask" | "allow" | "deny" }[]
      /**
       * Takes effect at the START OF THE NEXT TURN, not mid-turn: `runLoop`
       * snapshots the session row once at entry (`session/prompt.ts`) and reuses it
       * for every step. The write itself is harmless mid-turn — it just will not be
       * observed by the turn already running. The UI must say so rather than
       * implying the change is live.
       */
      appliesFrom: "next-turn"
    }
  /**
   * ONE delivery for every harness that has a real mode surface — ACP, Claude,
   * Codex and Cursor alike.
   *
   * This replaced four sibling variants, one per harness, each carrying that
   * harness's own parameters (`permissionMode`, `approvalPolicy` + `sandbox`,
   * `sandboxOptions` + `autoReview`, `modeId`). Those existed while the app was
   * deciding what to send. It no longer does: the runtime owns each harness's
   * translation now, and the app's whole job is to pass back an id it was given.
   *
   * Keeping the per-harness shapes would mean the app re-deriving, from a
   * `HarnessId`, facts the runtime already knows — which is precisely how the
   * mechanism table came to assert things that were not true of the installed
   * SDKs.
   */
  | {
      kind: "harness-permission-mode"
      modeId: string
      /**
       * Straight from the harness, never assumed. `next-session` is real and
       * only Cursor reports it: its options are read by `Agent.create`, so a
       * change cannot reach the session on screen at all.
       */
      appliesFrom: "next-turn" | "next-session"
    }

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
 * Auto expressed in opencode's own rule vocabulary.
 *
 * Order matters and is the reason this is a list: `Permission.evaluate` collects
 * every rule whose `permission`/`pattern` match and takes the LAST one, so the
 * catch-all must come FIRST and every grant after it.
 *
 * `pattern: "*"` on each entry means "any argument to this tool". That is
 * deliberately as far as this goes for `bash`: the engine already tree-sitter-parses
 * shell and generalises commands via `BashArity` (`git checkout main` becomes
 * `git checkout *`), so pattern-scoped bash grants ARE expressible — but choosing
 * which command patterns are safe is the shell-classification problem the owner
 * ruled out of scope. So `bash` stays in the ask tier rather than shipping a
 * half-guessed allowlist.
 *
 * The danger tier is listed explicitly even though `*` already denies it by
 * default. Two reasons: it states the intent where a reader will look for it, and
 * because the session handler MERGES rulesets, an explicit late `ask` cannot be
 * outranked by an `allow` for the same permission left behind by a previous mode.
 */
function opencodeAutoRuleset(): readonly { permission: string; pattern: string; action: "ask" | "allow" | "deny" }[] {
  const allow = (keys: readonly string[]) =>
    keys.map((permission) => ({ permission, pattern: "*", action: "allow" as const }))
  return [
    { permission: "*", pattern: "*", action: "ask" },
    ...allow(SAFE_READ_PERMISSIONS),
    ...allow(INTERACTIVE_PERMISSIONS),
    ...allow(IN_PROJECT_WRITE_PERMISSIONS),
    ...DANGER_GATED_PERMISSIONS.map((permission) => ({ permission, pattern: "*", action: "ask" as const })),
  ]
}

/**
 * Withdraw everything the permissive opencode ruleset granted.
 *
 * Required, not optional. Granting writes rules into the engine's PERSISTED
 * ruleset, so the way back has to withdraw them — otherwise the control is
 * one-way and the engine stays permissive after the user has visibly changed it.
 * That is a security regression, and it is invisible from the UI because the
 * picker would read "ask for everything" while the stored rules still say allow.
 *
 * Withdrawal works BECAUSE the handler merges rather than replaces: the incoming
 * rules land after the existing ones and `Permission.evaluate` takes the last
 * match, so a later `ask` beats an earlier `allow`. No endpoint deletes rules,
 * which makes this the only way to revoke.
 */
function opencodeAskRuleset(): readonly { permission: string; pattern: string; action: "ask" | "allow" | "deny" }[] {
  const ask = (keys: readonly string[]) =>
    keys.map((permission) => ({ permission, pattern: "*", action: "ask" as const }))
  return [
    { permission: "*", pattern: "*", action: "ask" },
    ...ask(SAFE_READ_PERMISSIONS),
    ...ask(INTERACTIVE_PERMISSIONS),
    ...ask(IN_PROJECT_WRITE_PERMISSIONS),
    ...ask(DANGER_GATED_PERMISSIONS),
  ]
}

export const CLAXEDO_ALLOW_SAFE_ID = "claxedo-allow-safe"
export const CLAXEDO_ASK_ALWAYS_ID = "claxedo-ask-always"

/**
 * Claxedo's own two options, for the harnesses that have no modes of their own.
 *
 * Named for WHAT THEY DO rather than for a tier. There is deliberately no "Auto"
 * anywhere in this file any more: "Auto" named a Claxedo abstraction and told the
 * user nothing about what would actually happen, while meaning something
 * materially different on each harness — a persisted engine ruleset in one place,
 * Claxedo answering prompts in-process in another. Two things that differ in who
 * enforces them and whether they survive the app closing should not share a word.
 *
 * These appear ONLY where the harness has nothing of its own. Everywhere else the
 * harness's own names are shown, because a name we did not write cannot drift
 * from what the harness does.
 */
export function claxedoPermissionModes(harness: HarnessId): readonly PermissionModeOption[] {
  const mechanism = PERMISSION_MECHANISMS[harness]

  if (mechanism.kind === "opencode-session-ruleset") {
    return [
      {
        id: CLAXEDO_ALLOW_SAFE_ID,
        name: "Allow reads and edits",
        description: "Reads and in-project edits run without asking; commands and network still ask",
        origin: "claxedo",
        caveat: "Applies from your next message; the turn already running keeps its current rules",
        delivery: { kind: "opencode-session-ruleset", ruleset: opencodeAutoRuleset(), appliesFrom: "next-turn" },
      },
      {
        id: CLAXEDO_ASK_ALWAYS_ID,
        name: "Ask for everything",
        description: "Every tool call waits for you",
        origin: "claxedo",
        caveat: "Applies from your next message; the turn already running keeps its current rules",
        delivery: { kind: "opencode-session-ruleset", ruleset: opencodeAskRuleset(), appliesFrom: "next-turn" },
      },
    ]
  }

  // Everywhere else Claxedo answers the harness's own prompts in-process. The
  // caveat says so rather than letting this look like the harness was configured:
  // nothing is enforced, and the grants die with the app.
  return [
    {
      id: CLAXEDO_ALLOW_SAFE_ID,
      name: "Allow reads and edits",
      description: "Reads and in-project edits run without asking; commands and network still ask",
      origin: "claxedo",
      caveat: "Claxedo answers these prompts on your behalf; the harness enforces nothing",
      delivery: { kind: "claxedo-auto-answer", autoAnswer: CLAXEDO_AUTO_ANSWERS, respondWith: "always" },
    },
    {
      id: CLAXEDO_ASK_ALWAYS_ID,
      name: "Ask for everything",
      description: "Every tool call waits for you",
      origin: "claxedo",
      delivery: { kind: "claxedo-auto-answer", autoAnswer: [], respondWith: "once" },
    },
  ]
}

/**
 * What the harness itself reported, as served by the runtime.
 *
 * Structurally the runtime's `AgentPermissionModeState`, redeclared so this
 * module does not depend on the runtime package — see the wire-shape note on
 * `AgentRuntimePermissionModeState`.
 */
export type HarnessModeReport = {
  modes: readonly { id: string; name: string; description?: string; level?: "ask" | "auto" | "full" }[]
  currentModeId?: string
  unsupported?: string
  appliesFrom: "next-turn" | "next-session"
}

export type HarnessPermissionModes = {
  modes: readonly PermissionModeOption[]
  /** Set when `modes` is empty: why this harness offers nothing to pick. */
  unavailable?: string
}

/**
 * The harness's own modes, converted for display.
 *
 * Every field the user sees comes from `report`. Nothing here consults
 * `HarnessId` to decide what a mode does, which is the point: the app used to
 * hold a table of what each SDK supported, and that table was wrong about three
 * harnesses at once because nothing forced it to agree with the installed
 * packages. The runtime reads the packages; this renders what it says.
 */
export function harnessPermissionModes(input: {
  harness: HarnessId
  report?: HarnessModeReport
}): HarnessPermissionModes {
  const label = HARNESS_LABELS[input.harness]
  const report = input.report

  // Not yet fetched. Genuinely transient, and distinct from every case below.
  if (!report) return { modes: [], unavailable: `Loading ${label}'s permission modes…` }

  if (report.unsupported) return { modes: [], unavailable: report.unsupported }

  // A 200 whose body is not actually a mode report — a proxy error page, a
  // server mid-deploy, a mis-scoped route — must degrade to "unavailable" here.
  // `readJson` does no shape validation, so without this guard the `.length`
  // below throws during the composer's render, and a render-time throw takes
  // the whole app shell into the ErrorBoundary: the user gets a blank "Something
  // went wrong" page instead of one control that could not load.
  if (!Array.isArray(report.modes)) {
    return { modes: [], unavailable: `${label} returned an unreadable permission-mode report` }
  }

  if (report.modes.length === 0) {
    return { modes: [], unavailable: `${label} has not reported any permission modes for this session` }
  }

  return {
    modes: report.modes.map((mode) => ({
      id: mode.id,
      // The harness's own name and description, verbatim.
      name: mode.name,
      ...(mode.description ? { description: mode.description } : {}),
      origin: "harness" as const,
      ...(report.appliesFrom === "next-session"
        ? { caveat: `Applies to the next ${label} agent, not this session` }
        : {}),
      delivery: {
        kind: "harness-permission-mode" as const,
        modeId: mode.id,
        appliesFrom: report.appliesFrom,
      },
    })),
  }
}

/**
 * Everything the picker shows.
 *
 * The two groups are mutually exclusive by design: a harness either has modes of
 * its own or it does not. Showing Claxedo's options ALONGSIDE a harness's own
 * would put two controls over the same behaviour in one menu with no way to tell
 * which wins — and on every harness that has modes, the harness's are strictly
 * better, because they are enforced where the tools actually run.
 */
export function permissionModeOptions(input: {
  harness: HarnessId
  report?: HarnessModeReport
}): { claxedo: readonly PermissionModeOption[]; harness: HarnessPermissionModes } {
  const harness = harnessPermissionModes(input)
  if (harness.modes.length > 0) return { claxedo: [], harness }
  return { claxedo: claxedoPermissionModes(input.harness), harness }
}

/**
 * The mode to start on when the user has chosen nothing.
 *
 * Prefers what the HARNESS says is current — it is the truth about the session,
 * and on a resumed session it is the mode already in force. Only when the harness
 * reports no current mode does this fall to the `auto` rung, and then to the
 * first option, so a picker is never blank while a real mode is running.
 */
export function defaultPermissionSelection(input: {
  harness: HarnessId
  report?: HarnessModeReport
}): PermissionSelection {
  const report = input.report
  // `Array.isArray` for the same reason as `harnessPermissionModes` above: this
  // runs inside the composer's `selection` memo, so an unreadable report would
  // throw during render and take the whole shell into the ErrorBoundary rather
  // than degrading this one control.
  if (report && Array.isArray(report.modes) && report.modes.length > 0) {
    const current = report.currentModeId
      ? report.modes.find((mode) => mode.id === report.currentModeId)
      : undefined
    const chosen = current ?? report.modes.find((mode) => mode.level === "auto") ?? report.modes[0]!
    return { kind: "harness", modeId: chosen.id }
  }
  return { kind: "claxedo", modeId: CLAXEDO_ALLOW_SAFE_ID }
}

/** Resolve a selection to the option it refers to, or undefined if it is stale. */
export function findPermissionModeOption(input: {
  selection: PermissionSelection
  harness: HarnessId
  report?: HarnessModeReport
}): PermissionModeOption | undefined {
  const selection = input.selection
  // Bound to a local before the callback: TypeScript discards narrowing on a
  // property access once it is read inside a closure.
  const modeId = selection.modeId
  if (selection.kind === "claxedo") {
    return claxedoPermissionModes(input.harness).find((mode) => mode.id === modeId)
  }
  return harnessPermissionModes(input).modes.find((mode) => mode.id === modeId)
}
