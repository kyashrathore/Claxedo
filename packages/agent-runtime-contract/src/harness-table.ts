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
   * Every registry provider id whose stored row this harness can run on: the
   * bindings it resolves auth through, then the vendor binding it falls back to
   * when none of them holds an account. `claudeAuthValue` reads `claude-sdk`
   * then `anthropic`, and `cursorAuthValue` reads `cursor-sdk` then `cursor`,
   * so a reader that stopped at the aliases would drop a working account.
   */
  providerIds: readonly string[]
  /** The provider id a sign-in for this harness is stored against. */
  connectProvider: string
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
    providerIds: ["claude-acp", "claude-sdk", "anthropic"],
    connectProvider: "claude-sdk",
    machineLoginServes: ["claude-acp", "claude-sdk"],
  },
  codex: {
    label: "Codex",
    vendor: "OpenAI",
    providerIds: ["codex-app-server", "openai"],
    connectProvider: "codex-app-server",
    machineLoginServes: ["codex-app-server", "openai"],
  },
  cursor: {
    label: "Cursor",
    vendor: "Cursor",
    providerIds: ["cursor-acp", "cursor-sdk", "cursor"],
    connectProvider: "cursor-sdk",
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
