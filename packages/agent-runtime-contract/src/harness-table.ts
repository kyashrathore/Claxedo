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

export const HARNESS_IDS = ["claude", "codex", "cursor"] as const

export type HarnessId = (typeof HARNESS_IDS)[number]

export type HarnessRecord = {
  /** The product's own name, as every surface writes it. */
  label: string
  vendor: string
  /**
   * Every registry provider id whose stored row this harness can run on:
   * connect provider first, then the other harness binding, then the vendor
   * fallback.
   *
   * The order is load-bearing at both ends. A connect card stores under
   * `connectProvider`, and a resolver that asks which stored row a turn will
   * spend takes the first of these that has one. `claudeAuthValue` reads
   * `claude-sdk` then `anthropic` and `cursorAuthValue` reads `cursor-sdk` then
   * `cursor`, so a list that stopped at the aliases would drop a working
   * account.
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
}

export const HARNESS_TABLE: Readonly<Record<HarnessId, HarnessRecord>> = {
  claude: {
    label: "Claude Code",
    vendor: "Anthropic",
    providerIds: ["claude-sdk", "claude-acp", "anthropic"],
    connectProvider: "claude-sdk",
    vendorProvider: "anthropic",
    machineLoginServes: ["claude-sdk", "claude-acp"],
  },
  codex: {
    label: "Codex",
    vendor: "OpenAI",
    providerIds: ["codex-app-server", "openai"],
    connectProvider: "codex-app-server",
    vendorProvider: "openai",
    machineLoginServes: ["codex-app-server", "openai"],
  },
  cursor: {
    label: "Cursor",
    vendor: "Cursor",
    providerIds: ["cursor-sdk", "cursor-acp", "cursor"],
    connectProvider: "cursor-sdk",
    vendorProvider: "cursor",
    machineLoginServes: ["cursor-acp"],
  },
}

export function isHarnessId(value: string): value is HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(value)
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
