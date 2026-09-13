import { HARNESS_TABLE, harnessForProviderId } from "@claxedo/agent-runtime-contract"
import type { NativeHarnessId } from "@/platform/identity/harness-selection"

/** One harness as this app draws it: the shared record, plus its brand mark. */
type HarnessEntry = {
  label: string
  vendor: string
  /** The brand mark the harness is recognised by; its login is the vendor's. */
  icon: string
  /** Every registry provider id the harness resolves auth through. */
  providerIds?: readonly string[]
  /** The provider id a sign-in for this harness is stored against. */
  connectProvider?: string
}

/**
 * How each harness is named and marked to a reader, and which provider ids its
 * login is stored under.
 *
 * Ids, names and provider ids are `HARNESS_TABLE`'s: the server stores a login
 * against those ids and the machine scan reports them, so a second list here
 * loses an account the moment the two disagree. `pi` and `opencode` are engines
 * a reader picks rather than logins anything is stored against, so they carry a
 * name and a mark and nothing else.
 */
export const HARNESS_CATALOG = {
  claude: { ...HARNESS_TABLE.claude, icon: "anthropic" },
  codex: { ...HARNESS_TABLE.codex, icon: "openai" },
  cursor: { ...HARNESS_TABLE.cursor, icon: "cursor" },
  pi: { label: "Pi", vendor: "Pi", icon: "pi" },
  opencode: { label: "OpenCode", vendor: "OpenCode", icon: "opencode" },
} as const satisfies Record<NativeHarnessId, HarnessEntry>

function entry(id: string): HarnessEntry | undefined {
  return (HARNESS_CATALOG as Record<string, HarnessEntry | undefined>)[id]
}

export function harnessLabel(id: string): string | undefined {
  return entry(id)?.label
}

/**
 * The name to put on a key no catalog entry answers to — a historical session's
 * harness, an operator's ACP connection id. The server-supplied label is
 * preferred wherever discovery data is at hand; this is the label of last
 * resort, and it beats printing `team-agent`.
 */
export function harnessDisplayLabel(key: string): string {
  const known = harnessLabel(key)
  if (known) return known
  return key
    .split(/[-_]/g)
    .filter(Boolean)
    .map((item) => item[0]?.toUpperCase() + item.slice(1))
    .join(" ")
}

/** Where a turn on one account can run. */
export type AccountReach = "local-and-cloud" | "local-only"

/**
 * A stored account is a token Claxedo holds, so the loopback broker hands it to
 * a turn on this computer and `sandboxBrokeredSecrets` hands it to each
 * driver's native brokering for a turn in a cloud sandbox. This computer's own
 * login is a file the harness wrote on this machine and nothing carries it off
 * the machine, so a workspace on a sandbox has no such login to run on.
 */
export function accountReach(machineLogin: boolean): AccountReach {
  return machineLogin ? "local-only" : "local-and-cloud"
}

/**
 * Which places a reach draws, and what the pair of them means, as dictionary
 * keys. A reach is two facts about one account and the icons say them one each,
 * so `local-and-cloud` is `local-only` plus the cloud rather than a third mark
 * a reader has to learn. The names are catalog entries; `as const` keeps them
 * narrow enough for `ClaxedoIcon` to reject a typo without this module
 * depending on the icon layer.
 */
export const ACCOUNT_REACH_KEYS = {
  "local-and-cloud": {
    places: [
      { icon: "monitor", label: "settings.providers.agents.reachLocal" },
      { icon: "cloud", label: "settings.providers.agents.reachCloud" },
    ],
    note: "settings.providers.agents.reachLocalCloudNote",
  },
  "local-only": {
    places: [{ icon: "monitor", label: "settings.providers.agents.reachLocal" }],
    note: "settings.providers.agents.reachLocalOnlyNote",
  },
} as const satisfies Record<AccountReach, {
  places: ReadonlyArray<{ icon: string; label: string }>
  note: string
}>

/**
 * What the connect card is setting up, in the words it will use.
 *
 * `harness` is a login the harness itself runs on — one account, one harness.
 * `engine` is a vendor's models being made available inside an engine that can
 * run several vendors, which is a different sentence: the account is not the
 * thing being run.
 */
export type ConnectContext =
  | { kind: "harness"; harness: string; vendor: string }
  | { kind: "engine"; engine: string; vendor: string }

/** The connect card's context for a harness that runs on one account's login. */
export function harnessConnectContext(harness: string, fallbackLabel?: string): ConnectContext {
  const known = entry(harness)
  const label = known?.label ?? fallbackLabel ?? harness
  return { kind: "harness", harness: label, vendor: known?.vendor ?? label }
}

/** The connect card's context for a vendor's models inside a multi-vendor engine. */
export function engineConnectContext(engine: string, vendor: string): ConnectContext {
  return { kind: "engine", engine: harnessLabel(engine) ?? engine, vendor }
}

export function harnessIcon(id: string): string {
  return entry(id)?.icon ?? id
}

/**
 * How a key that may be either a harness id or one of its provider ids is
 * named to a reader. A registry key — `claude-sdk`, `codex-app-server` — names
 * the binding a login is stored against and nothing a reader would recognise.
 */
export function harnessLabelForProviderId(providerId: string): string | undefined {
  return harnessLabel(harnessForProviderId(providerId) ?? providerId)
}

/** The provider ids a harness's accounts are stored under, its connect id first. */
export function harnessProviderIds(id: string): readonly string[] {
  return entry(id)?.providerIds ?? []
}

export function harnessConnectProvider(id: string): string | undefined {
  return entry(id)?.connectProvider
}

/**
 * The harness whose own login is stored under this provider id, for the id its
 * connect card writes. Every other provider id — `openai` under Codex, say —
 * names a vendor an engine can run, which is a different sentence on the card.
 */
export function harnessForConnectProvider(providerId: string): string | undefined {
  return Object.keys(HARNESS_CATALOG).find((id) => harnessConnectProvider(id) === providerId)
}

/**
 * The context for a surface that knows a provider id and the engine it is
 * setting up, and cannot tell in advance which of the two sentences it needs.
 */
export function connectContextFor(input: { providerId: string; engine: string; vendor: string }): ConnectContext {
  const harness = harnessForConnectProvider(input.providerId)
  return harness ? harnessConnectContext(harness) : engineConnectContext(input.engine, input.vendor)
}
