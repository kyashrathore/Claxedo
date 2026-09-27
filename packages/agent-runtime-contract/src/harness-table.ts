/**
 * The harnesses Claxedo runs turns on, and the provider ids each resolves its
 * auth through.
 *
 * Data only, and in the contract package rather than beside any one consumer:
 * the server decides which binding a sign-in is stored against, the machine
 * scan decides which bindings a CLI login drives, and the app draws one row per
 * harness. Held separately those lists drifted — `cursor-sdk` was in one and
 * not another — and a provider id missing from a list loses its login without
 * anything failing.
 */

import {
  CLAUDE_PERMISSION_MODES,
  CODEX_PERMISSION_MODES,
  CURSOR_PERMISSION_MODES,
  defaultPermissionModeId,
  type HarnessPermissionModes,
} from "./harness-permission-modes"
import { harnessKey, type SessionHarness } from "./harnesses"

export const HARNESS_IDS = ["claude", "codex", "cursor"] as const

export type HarnessId = (typeof HARNESS_IDS)[number]

type HarnessRecord = {
  /** The product's own name, as every surface writes it. */
  label: string
  vendor: string
  /**
   * Every registry provider id whose stored row this harness can run on:
   * connect provider first, then the other harness binding, then the vendor
   * fallback.
   *
   * The order is load-bearing at both ends. A connect card stores under
   * `connectProvider`, and `harnessProjection` takes the first of these ids a
   * projection map holds — so a Claude turn binds through `claude-sdk` when one
   * is selected and through a plain `anthropic` key when it is not, and a list
   * that stopped at the aliases would drop that key.
   */
  providerIds: readonly string[]
  /** The provider id a sign-in for this harness is stored against. */
  connectProvider: string
  /**
   * The one id in `providerIds` that names the vendor rather than this
   * harness's own binding. `providerIds` minus this is the set of bindings the
   * harness resolves auth through, which is what a reader comparing a login's
   * reach against the harness's own bindings has to compare with.
   */
  vendorProvider: string
  /**
   * Those of `providerIds` the CLI's own login drives. `cursor-agent login`
   * signs the CLI in and Cursor ACP runs on it; the Cursor SDK takes its key as
   * an `Agent.create` argument and refuses a turn however signed in the CLI is.
   */
  machineLoginServes: readonly string[]
  permissionModes: HarnessPermissionModes
  /**
   * The model row a session that stored no model runs on, where the harness
   * declares one without asking its live catalog. Absent on codex: an unnamed
   * model is the app-server's own configured default, which only `model/list`
   * reports.
   */
  defaultModelId?: string
}

export const HARNESS_TABLE: Readonly<Record<HarnessId, HarnessRecord>> = {
  claude: {
    label: "Claude Code",
    vendor: "Anthropic",
    providerIds: ["claude-sdk", "claude-acp", "anthropic"],
    connectProvider: "claude-sdk",
    vendorProvider: "anthropic",
    machineLoginServes: ["claude-sdk", "claude-acp"],
    permissionModes: CLAUDE_PERMISSION_MODES,
    defaultModelId: "default",
  },
  codex: {
    label: "Codex",
    vendor: "OpenAI",
    providerIds: ["codex-app-server", "openai"],
    connectProvider: "codex-app-server",
    vendorProvider: "openai",
    machineLoginServes: ["codex-app-server", "openai"],
    permissionModes: CODEX_PERMISSION_MODES,
  },
  cursor: {
    label: "Cursor",
    vendor: "Cursor",
    providerIds: ["cursor-sdk", "cursor-acp", "cursor"],
    connectProvider: "cursor-sdk",
    vendorProvider: "cursor",
    machineLoginServes: ["cursor-acp"],
    permissionModes: CURSOR_PERMISSION_MODES,
    defaultModelId: "auto",
  },
}

export function isHarnessId(value: string): value is HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(value)
}

function tableHarness(harness: SessionHarness): HarnessId | undefined {
  return harness.access === "native" && isHarnessId(harness.id) ? harness.id : undefined
}

/**
 * The permission modes a session's harness declares. Undefined for an ACP
 * connection, whose agent reports its own list, and for a native harness with
 * no mode surface.
 */
export function declaredPermissionModes(harness: SessionHarness): HarnessPermissionModes | undefined {
  const id = tableHarness(harness)
  return id ? HARNESS_TABLE[id].permissionModes : undefined
}

/**
 * The mode a session runs under: the stored one while its harness still offers
 * it, else the harness's `auto` rung. A harness the table does not describe
 * runs what was stored, or nothing that anyone chose.
 */
export function effectivePermissionModeId(harness: SessionHarness, stored: string | null | undefined): string | null {
  const table = declaredPermissionModes(harness)
  if (!table) return stored ?? null
  if (stored && table.modes.some((mode) => mode.id === stored)) return stored
  return defaultPermissionModeId(table) ?? null
}

/** The model a session runs on: the stored one, else the row its harness declares as default. */
export function effectiveSessionModel(
  harness: SessionHarness,
  stored: { providerID: string; modelID: string } | undefined,
): { providerID: string; modelID: string } | undefined {
  if (stored) return stored
  const id = tableHarness(harness)
  const modelID = id ? HARNESS_TABLE[id].defaultModelId : undefined
  const providerID = modelID ? harnessKey(harness) : undefined
  return modelID && providerID ? { providerID, modelID } : undefined
}

/**
 * The harness a provider id belongs to, where one does. Every other provider id
 * names a vendor an engine can run rather than a harness's own login, and has
 * no harness to be listed under.
 */
export function harnessForProviderId(id: string): HarnessId | undefined {
  return HARNESS_IDS.find((harness) => HARNESS_TABLE[harness].providerIds.includes(id))
}

/** The bindings a harness resolves its own auth through: everything but the vendor id. */
export function harnessBindingIds(harness: HarnessId): string[] {
  const record = HARNESS_TABLE[harness]
  return record.providerIds.filter((id) => id !== record.vendorProvider)
}

/**
 * Every stored provider id whose row can stand in for one vendor, the vendor's
 * own id first and the harness logins behind it.
 *
 * A subscription connected for Claude Code is an Anthropic login and nothing
 * about it is Claude Code's alone — the broker sends it to the same origin and
 * the same paths an Anthropic key goes to, differing only in the header it
 * rides in. So an engine that runs Anthropic models resolves it here instead
 * of asking for the account a second time.
 *
 * The vendor leads, which is the opposite of the order `harnessProjection`
 * reads. Both are right about their own question: Claude Code asked which
 * login to run ITSELF on and its own binding is the answer, while an engine
 * borrowing the vendor spends the key that was pasted for the vendor before it
 * reaches for a subscription that belongs to another product. The engine's
 * overlay precedence already resolved a tie this way, and two orders for one
 * question is how they would come to disagree.
 *
 * Structure only. Whether a candidate can be bound at all is the broker's
 * answer (a provider with no destination row has no binding), and whether this
 * vendor's binding can spend a given form is the caller's: a ChatGPT plan and
 * an OpenAI key reach different origins, so an engine provider that means the
 * key must not take the plan.
 */
export function vendorCredentialProviderIds(vendorProvider: string): string[] {
  const bindings = HARNESS_IDS
    .filter((harness) => HARNESS_TABLE[harness].vendorProvider === vendorProvider)
    .flatMap((harness) => harnessBindingIds(harness))
  return [...new Set([vendorProvider, ...bindings])]
}
