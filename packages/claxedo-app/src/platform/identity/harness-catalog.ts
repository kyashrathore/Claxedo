import type { NativeHarnessId } from "@/platform/identity/harness-selection"

/**
 * How each harness and the vendor behind its login are named to a reader.
 *
 * The single owner of these words. A provider id — `claude-sdk`,
 * `codex-app-server`, `cursor-sdk` — is a registry key and means nothing to
 * anyone reading a connect card, so every user-facing surface resolves through
 * here rather than falling back to the id when the model catalog has never
 * heard of it.
 */
export const HARNESS_CATALOG = {
  claude: { label: "Claude Code", vendor: "Anthropic" },
  codex: { label: "Codex", vendor: "OpenAI" },
  cursor: { label: "Cursor", vendor: "Cursor" },
  pi: { label: "Pi", vendor: "Pi" },
  opencode: { label: "OpenCode", vendor: "OpenCode" },
} as const satisfies Record<NativeHarnessId, { label: string; vendor: string }>

export function harnessLabel(id: string): string | undefined {
  return (HARNESS_CATALOG as Record<string, { label: string } | undefined>)[id]?.label
}

export function harnessVendor(id: string): string | undefined {
  return (HARNESS_CATALOG as Record<string, { vendor: string } | undefined>)[id]?.vendor
}

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
  const known = (HARNESS_CATALOG as Record<string, { label: string; vendor: string } | undefined>)[harness]
  const label = known?.label ?? fallbackLabel ?? harness
  return { kind: "harness", harness: label, vendor: known?.vendor ?? label }
}

/** The connect card's context for a vendor's models inside a multi-vendor engine. */
export function engineConnectContext(engine: string, vendor: string): ConnectContext {
  return { kind: "engine", engine: harnessLabel(engine) ?? engine, vendor }
}

/**
 * The provider id a harness's own login is stored under, and the id its connect
 * card writes. Every other provider id names a vendor an engine can run, which
 * is a different sentence on the card.
 */
export const HARNESS_CONNECT_PROVIDER = {
  claude: "claude-sdk",
  codex: "codex-app-server",
  cursor: "cursor-sdk",
} as const satisfies Partial<Record<NativeHarnessId, string>>

export function harnessForConnectProvider(providerId: string): string | undefined {
  return Object.entries(HARNESS_CONNECT_PROVIDER).find(([, id]) => id === providerId)?.[0]
}

/**
 * The context for a surface that knows a provider id and the engine it is
 * setting up, and cannot tell in advance which of the two sentences it needs.
 */
export function connectContextFor(input: { providerId: string; engine: string; vendor: string }): ConnectContext {
  const harness = harnessForConnectProvider(input.providerId)
  return harness ? harnessConnectContext(harness) : engineConnectContext(input.engine, input.vendor)
}
