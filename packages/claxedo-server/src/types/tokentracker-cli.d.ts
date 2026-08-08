// Deep import into tokentracker-cli's library surface (the package ships no
// types and no exports map). Shape guarded by usage-limits.contract.test.ts —
// keep both in sync when bumping the pinned version.
declare module "tokentracker-cli/src/lib/usage-limits.js" {
  /**
   * Per-provider quota snapshot. Providers: claude, codex, cursor, kimi,
   * gemini, kiro, antigravity, copilot, grok, zcode, opencodeGo. Each is
   * `{ configured: false }` or `{ configured: true, error: string | null, ... }`
   * with provider-specific windows (claude: five_hour/seven_day with
   * `utilization`; codex: primary_window/secondary_window with `used_percent`).
   */
  export type UsageLimitsSnapshot = {
    fetched_at: string
  } & Record<string, unknown>

  export function getUsageLimits(options?: {
    // tokentracker does NOT default these — omit `home` and every credential
    // file under ~ reads as "not configured" (see server-usage-limits.ts).
    home?: string
    env?: NodeJS.ProcessEnv
    providerTimeoutMs?: number
  }): Promise<UsageLimitsSnapshot>

  export function resetUsageLimitsCache(): void
}

declare module "tokentracker-cli/src/lib/subscriptions.js" {
  /** Cross-platform Claude Code OAuth reader (Keychain on darwin, ~/.claude/.credentials.json elsewhere). */
  export function readClaudeCodeAccessToken(options?: {
    platform?: NodeJS.Platform
    home?: string
    securityRunner?: unknown
  }): string | undefined

  /** Codex token bundle from ~/.codex/auth.json + accounts dir (includes refresh_token). */
  export function readCodexAuthBundle(options?: {
    home?: string
    env?: NodeJS.ProcessEnv
  }): Promise<Record<string, unknown> | undefined>
}

declare module "tokentracker-cli/src/lib/embedded-history.js" {
  export type EmbeddedHistoryRow = {
    app: string
    source: string
    model: string
    bucket_start: number
    native_session_id: string
    input_tokens: number
    output_tokens: number
    reasoning_output_tokens: number
    cached_input_tokens: number
    cache_creation_input_tokens: number
  }
  export function scanLocalHistory(options: {
    sourceHome: string
    stateDir: string
    since: number
    until: number
    sources?: string[]
    upload: false
    telemetry: false
    classify(input: { source: string; nativeSessionId: string; observedAt: number }): string | Promise<string>
  }): Promise<{
    rows: EmbeddedHistoryRow[]
    coverage: Array<{ source: string; status: "available" | "degraded" | "unavailable" | "unsupported"; error?: string | null }>
    classified_claxedo: number
    unclassified: number
  }>
}

declare module "tokentracker-cli/src/lib/pricing/index.js" {
  export function getModelPricing(model: string, options?: { source?: string }): {
    input: number
    output: number
    cache_read?: number
    cache_write?: number
  }
  export function __getStateForTests(): { source?: string | null }
}
