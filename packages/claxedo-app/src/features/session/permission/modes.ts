import type { HarnessId } from "@/platform/identity/session-ref"
import { harnessPermissionLabel, permissionMechanism } from "@/features/session/permission/mechanisms"

/**
 * Permission modes, named by whoever enforces them.
 *
 * The harness's OWN modes — its ids, its names, its descriptions, fetched per
 * session from the runtime, which reads them off the installed SDK. Where a
 * harness reports any, they are the WHOLE picker and Claxedo names nothing.
 *
 * Claxedo's own two options ("Auto", "Ask for everything") appear only where the
 * harness reports none, so that a picker is never empty on a harness that still
 * has a real policy to set.
 *
 * Three designs have been tried here and the reasoning is worth keeping. The
 * first invented five abstract modes and mapped them onto every harness, naming
 * capabilities that did not exist. The third put a single Claxedo "Auto" above
 * every harness's own list as a collapsed LABEL over whichever rung enforced it.
 * That reads well in the abstract and was noise in practice: on a harness whose
 * own auto rung is literally called "Auto" — Claude's classifier — the label
 * duplicated the row it pointed at, so the menu opened on a summary of one of
 * its own hidden rows and made the real list a click away for no gain.
 *
 * So the second design is the one that stands: the two groups are mutually
 * exclusive. A harness either enforces its own modes, in which case those are
 * what the user picks from, or it enforces none, in which case Claxedo's do the
 * work. Nothing sits above a list summarising it.
 *
 * The rule that survives all of them: a name the user reads must come from
 * whoever enforces the behaviour. Names we write can drift from what the harness
 * does; names the harness reports cannot.
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
 * Generic bucket for `permission_decided` telemetry. NEVER the raw permission
 * string itself: opencode's permission namespace has an open tail — MCP tool
 * names, subagent ids, and the shell tool id are all dynamic — so forwarding it
 * verbatim risks leaking a connection or tool name into an analytics event.
 * Anything this table does not recognize, including every dynamic id above,
 * buckets to "other" rather than being forwarded raw.
 */
export type ToolKindCategory = "read" | "write" | "execute" | "network" | "interactive" | "other"

const WRITE_TOOL_KINDS: readonly string[] = [...IN_PROJECT_WRITE_PERMISSIONS, "delete", "move"]
const EXECUTE_TOOL_KINDS: readonly string[] = ["bash", "task", "skill", "doom_loop", "execute"]
const NETWORK_TOOL_KINDS: readonly string[] = ["webfetch", "websearch", "fetch", "external_directory"]

/** Classify a raw permission/tool-kind string for telemetry. Pure and total. */
export function classifyToolKind(permission: string | undefined): ToolKindCategory {
  if (!permission) return "other"
  if ((SAFE_READ_PERMISSIONS as readonly string[]).includes(permission)) return "read"
  if ((ACP_SAFE_TOOL_KINDS as readonly string[]).includes(permission)) return "read"
  if (WRITE_TOOL_KINDS.includes(permission)) return "write"
  if (EXECUTE_TOOL_KINDS.includes(permission)) return "execute"
  if (NETWORK_TOOL_KINDS.includes(permission)) return "network"
  if ((INTERACTIVE_PERMISSIONS as readonly string[]).includes(permission)) return "interactive"
  return "other"
}

export type PermissionDecidedProperties = {
  decision: "allow" | "deny"
  mode: "auto" | "manual"
  tool_kind: ToolKindCategory
}

/**
 * The `permission_decided` event body, shared by the manual dock decision
 * (`session-composer-state.ts`) and the auto-accept path (`providers/permission.tsx`)
 * so the two never drift on how a response maps to `decision`.
 */
export function permissionDecidedProperties(input: {
  response: "once" | "always" | "reject"
  /** The raw `PermissionRequest.permission` field — bucketed here, never forwarded raw. */
  toolKind: string | undefined
  mode: "auto" | "manual"
}): PermissionDecidedProperties {
  return {
    decision: input.response === "reject" ? "deny" : "allow",
    mode: input.mode,
    tool_kind: classifyToolKind(input.toolKind),
  }
}

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
 * The whole picker, for a harness whose tools cannot reach anything real.
 *
 * States the two facts that make a permission mode unnecessary rather than
 * merely absent, so nobody reads the empty menu as something being broken or
 * still loading. See `sandboxed-no-policy` in mechanisms.ts for the file:line
 * evidence behind both clauses.
 */
export const SANDBOXED_NO_POLICY_REASON =
  "No permission mode applies — Pi's shell is simulated (just-bash, in memory) and its tools run in Pi's cloud, so nothing reaches your machine."

/**
 * Claxedo's own two options, for the harnesses that have no modes of their own.
 *
 * These appear ONLY where the harness has nothing of its own. Everywhere else the
 * harness's own names are shown, because a name we did not write cannot drift
 * from what the harness does — and a Claxedo option beside a harness's own list
 * is a second control over one behaviour with no way to tell which wins.
 */
export function claxedoPermissionModes(input: {
  harness: HarnessId
  report?: HarnessModeReport
  hasSession?: boolean
}): readonly PermissionModeOption[] {
  // A harness whose tools cannot reach anything real gets NO options, not even
  // Claxedo's own. Offering one would put a choosable control over a policy that
  // does not exist — the same defect as offering an option under a harness that
  // failed to start. `SANDBOXED_NO_POLICY_REASON` is shown in its place.
  if (permissionMechanism(input.harness).kind === "sandboxed-no-policy") return []
  // The harness reported modes, so it enforces its own policy and the picker is
  // its list alone. Claxedo previously added an "Auto" row above it that merely
  // pointed at whichever of those rows carried `level: "auto"` — on Claude that
  // row is itself named "Auto", so the menu opened showing a paraphrase of a row
  // it was hiding.
  // `readJson` does no shape validation (same constraint as the Array.isArray
  // guard in harnessPermissionModes): a 200 whose body lacks a `modes` array
  // must read as "no modes reported", not throw — this runs in a composer
  // render memo, and a render-time throw blanks the whole shell.
  const reportedModes = input.report?.modes
  if (Array.isArray(reportedModes) && reportedModes.length > 0) return []
  return [claxedoAutoOption(input), claxedoAskOption(input.harness, input.hasSession)]
}

/**
 * The next-turn caveat, or nothing on a draft.
 *
 * opencode's ruleset lands at the START of the next turn — `runLoop` snapshots
 * the session row once at entry — so on a live session the warning is real and
 * load-bearing. On a DRAFT it is neither: there is no turn running to keep its
 * current rules, and the first message creates the session and runs under
 * exactly this ruleset. Saying "applies from your next message" there tells the
 * user their choice will be ignored for the very turn it actually governs.
 *
 * Same shape as the `next-session` caveat cursor gets, and suppressed for the
 * same reason — a caveat about an existing session cannot be stated before one
 * exists.
 */
function nextTurnCaveat(hasSession: boolean | undefined) {
  if (hasSession === false) return {}
  return { caveat: "Applies from your next message; the turn already running keeps its current rules" }
}

/**
 * Auto, for a harness that reported no modes of its own.
 *
 * Two mechanisms only, because this is never reached when the harness has a
 * policy surface: opencode writes a session-scoped ruleset to the engine, and
 * everything else falls to Claxedo answering the safe permissions itself. The
 * caveat saying nothing is enforced therefore appears exactly where it is true.
 */
function claxedoAutoOption(input: { harness: HarnessId; hasSession?: boolean }): PermissionModeOption {
  if (permissionMechanism(input.harness).kind === "opencode-session-ruleset") {
    return {
      id: CLAXEDO_ALLOW_SAFE_ID,
      name: "Auto",
      origin: "claxedo" as const,
      // Auto means full access with the DANGER TIER still gated. The ruleset
      // below is that shape in opencode's vocabulary: a catch-all `ask`, then
      // grants for everything safe, leaving bash/network/out-of-project asking.
      description: "Everything runs without asking except shell, network and anything outside the project",
      ...nextTurnCaveat(input.hasSession),
      delivery: { kind: "opencode-session-ruleset", ruleset: opencodeAutoRuleset(), appliesFrom: "next-turn" },
    }
  }

  return localAnswerAutoOption()
}

/**
 * Claxedo answers the safe permissions itself.
 *
 * Extracted so the unidentified-harness path can reach it WITHOUT naming a
 * harness. That path used to build its options by calling
 * `permissionModeOptions({ harness: "pi" })` — pi being, at the time, the one
 * harness that reached this rung. That coupling broke the moment pi stopped
 * offering options at all, and it was always a misuse: the unknown-harness case
 * wants "the rung that assumes nothing about the harness", which is this one,
 * not "whatever pi happens to do".
 */
function localAnswerAutoOption(): PermissionModeOption {
  return {
    id: CLAXEDO_ALLOW_SAFE_ID,
    name: "Auto",
    origin: "claxedo",
    // Same shape as every other rung — CLAXEDO_AUTO_ANSWERS is exactly the
    // complement of DANGER_GATED_PERMISSIONS — but answered locally, which is
    // what the caveat is for.
    description: "Everything runs without asking except shell, network and anything outside the project",
    caveat: "Claxedo answers these prompts on your behalf; the harness enforces nothing",
    delivery: CLAXEDO_LOCAL_AUTO,
  }
}

/**
 * What to offer while the session's harness is still unidentified.
 *
 * Both options are Claxedo's own and assume nothing about the harness, so
 * neither can produce a ruleset write to the wrong engine. Withholding them
 * would leave a user with no permission control at all on a session whose
 * harness we merely failed to name yet.
 */
export function unidentifiedHarnessModes(): readonly PermissionModeOption[] {
  return [localAnswerAutoOption(), localAnswerAskOption()]
}

/** The off switch, manufactured only where the harness supplies none. */
function claxedoAskOption(harness: HarnessId, hasSession?: boolean): PermissionModeOption {
  if (permissionMechanism(harness).kind === "opencode-session-ruleset") {
    return {
      id: CLAXEDO_ASK_ALWAYS_ID,
      name: "Ask for everything",
      description: "Every tool call waits for you",
      origin: "claxedo",
      ...nextTurnCaveat(hasSession),
      delivery: { kind: "opencode-session-ruleset", ruleset: opencodeAskRuleset(), appliesFrom: "next-turn" },
    }
  }
  return localAnswerAskOption()
}

/** The off switch where Claxedo, not the harness, is the one answering. */
function localAnswerAskOption(): PermissionModeOption {
  return {
    id: CLAXEDO_ASK_ALWAYS_ID,
    name: "Ask for everything",
    description: "Every tool call waits for you",
    origin: "claxedo",
    delivery: { kind: "claxedo-auto-answer", autoAnswer: [], respondWith: "once" },
  }
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
  /** See `permissionModeOptions`. Suppresses next-session caveats on a draft. */
  hasSession?: boolean
}): HarnessPermissionModes {
  const label = harnessPermissionLabel(input.harness)
  const report = input.report

  // Checked FIRST, ahead of the loading and empty-report branches, because
  // neither is true here: this harness is not slow to answer and has not merely
  // failed to report — it has no policy surface and needs none. Saying "has not
  // reported any permission modes" would imply it might later.
  if (permissionMechanism(input.harness).kind === "sandboxed-no-policy") {
    return { modes: [], unavailable: SANDBOXED_NO_POLICY_REASON }
  }

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
      // Suppressed on a draft: there is no "this session" for the change to be
      // excluded from, and the first message will run under exactly this mode.
      ...(report.appliesFrom === "next-session" && input.hasSession !== false
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
  /**
   * Whether a session actually exists yet.
   *
   * Only `next-session` caveats care, and they care a lot: "applies to the next
   * agent, not this session" is meaningless on a DRAFT, where there is no this
   * session to be excluded from. The first message creates the session and picks
   * the mode up, so on a draft the choice is simply in force.
   */
  hasSession?: boolean
}): { claxedo: readonly PermissionModeOption[]; harness: HarnessPermissionModes } {
  const harness = harnessPermissionModes(input)
  // Exactly one of these is non-empty. `claxedoPermissionModes` returns nothing
  // once the harness has reported modes of its own, so the picker never renders
  // a Claxedo row above a list that already contains the mode it would apply.
  return { claxedo: claxedoPermissionModes(input), harness }
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
    // Always the harness's own id, including for the auto rung. This used to
    // return Claxedo's id when the rung was `auto`, because a Claxedo "Auto" row
    // then stood in front of the list and both being selected would have read as
    // two states. That row is gone, so naming the rung anything but the harness's
    // own word for it would now name a row the picker does not contain.
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
    return claxedoPermissionModes(input).find((mode) => mode.id === modeId)
  }
  return harnessPermissionModes(input).modes.find((mode) => mode.id === modeId)
}
