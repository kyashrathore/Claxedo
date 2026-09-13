/** Browser-safe contract for the single unified Usage endpoint. */
export type UsageTotals = {
  turnCount: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  unknownCategories: number
  partialTurnCount?: number
  unavailableTurnCount?: number
  errorTurnCount?: number
}

export type UsageSeries = { totals: UsageTotals; daily: Array<UsageTotals & { date: string }> }

export type UsageCost = {
  estimatedUsd: number
  pricedTokens: number
  unpricedTokens: number
  catalog: { adapter: string; version: string; source: string }
  daily?: Array<{ date: string; estimatedUsd: number; pricedTokens: number; unpricedTokens: number }>
}

export type UsageFilterDimension = "app" | "provider" | "harness" | "model" | "location" | "session" | "workspace"
export type UsageFilters = Partial<Record<UsageFilterDimension, string>>
export type UsageFilterOptions = Partial<Record<UsageFilterDimension, string[]>>

export type UsageBreakdownRow = UsageTotals & {
  value: string
  label: string
  estimatedUsd: number
  pricedTokens: number
  unpricedTokens: number
  status: "final" | "partial" | "unavailable" | "unpriced"
  href?: string
}

export type UsageBreakdownPage = {
  dimension: UsageFilterDimension
  rows: UsageBreakdownRow[]
  next?: string
}

export type UsageChartSeries = {
  dimension: string
  series: Array<{
    value: string
    label: string
    daily: Array<{
      date: string
      input: number
      output: number
      reasoning: number
      cacheRead: number
      cacheWrite: number
    }>
  }>
}

/** One plan window a vendor reports for an account, as the credential store holds it. */
export type QuotaWindow = {
  /** `session`, `weekly`, `weekly_opus`, or the vendor's own slot name. */
  window: string
  usedPercent: number
  resetsAt: number | null
}

/**
 * The Claxedo name for each window slot a vendor reports, per harness.
 *
 * One table across vendors would label half of them wrongly: `primary_window`
 * is a session for Codex and the whole billing cycle for Cursor. A harness, or
 * a slot, that is not listed keeps the vendor's own field name — inventing a
 * tier name for it would rot on the next vendor change without anything
 * failing.
 */
export const USAGE_WINDOW_NAMES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  claude: { five_hour: "session", seven_day: "weekly", seven_day_opus: "weekly_opus" },
  codex: {
    primary_window: "session",
    secondary_window: "weekly",
    credit_window: "credits",
    spark_primary_window: "spark_session",
    spark_secondary_window: "spark_weekly",
  },
  cursor: { primary_window: "plan", secondary_window: "auto", tertiary_window: "api" },
}

/**
 * Codex's own usage read names a window by its declared `limit_window_seconds`
 * rather than by the slot it arrives in: a free plan gets only the weekly
 * window, delivered in the primary slot.
 */
export const CODEX_WINDOW_NAME_BY_SECONDS: Readonly<Record<number, string>> = {
  18_000: "session",
  604_800: "weekly",
}

/**
 * One account a harness can run on, and what its plan has left.
 *
 * Flat and first-class rather than nested under a provider: a harness resolves
 * auth through several provider ids and one login is stored once per binding,
 * so a reader that grouped by provider would draw the same account twice.
 */
export type QuotaAccount = {
  /**
   * `claude`, `codex`, `cursor` — the harness this account runs. For an
   * `otherAgent` it is the id of the agent that reported the plan, which no
   * harness answers to.
   */
  harness: string
  /** The stored row this account is keyed by; absent for `machineLogin`. */
  credentialId?: string
  /** Set for the login a harness on this machine holds, which is no stored row. */
  machineLogin?: true
  /**
   * Set for an agent installed on this machine that Claxedo cannot run a turn
   * on. Its plan is worth showing — it is the same budget the user is spending
   * — but it is never a login Claxedo would send a turn to, so it can neither
   * be in use nor be reconnected from here.
   */
  otherAgent?: true
  /**
   * What names this account: the address the vendor gave it, or the name the
   * user gave the stored row. Absent only where the harness names no address,
   * which the reader words for itself.
   */
  label?: string
  /** The subscription, in the vendor's own word ("max", "pro"), where it names one. */
  plan?: string
  /** Whether this is the account the harness runs its next turn on. */
  inUse: boolean
  /** The provider's last verdict on a stored account. A machine login has none. */
  health?: "ok" | "auth_failed" | "no_billing" | "rate_capped" | "expired"
  windows: readonly QuotaWindow[]
  /** When those windows were read; absent on an account nothing has read yet. */
  usageAt?: number
  /**
   * Why this account carries no windows, where the reader was told. Distinct
   * from `health`, which is the provider's verdict on the credential itself: a
   * usable login can still have a plan read that was throttled or expired.
   */
  usageError?: string
}

/** Plan usage for every account this installation can name. */
export type QuotaSnapshot = { accounts: readonly QuotaAccount[] }

export type UnifiedUsageResponse = {
  version: 1
  range: { since: number; until: number; timeZone: string }
  /**
   * Whether the read itself produced anything. What is true of one account —
   * unread, refused, reporting no plan — is on that account and not here, so
   * `unavailable` means only that there is nothing to draw, and it carries the
   * `error` when a failure is why.
   */
  quota: { status: "available" | "unavailable"; snapshot?: QuotaSnapshot; error?: string }
  claxedo: UsageSeries & {
    cost: UsageCost
    locationShare: { localTokens: number; cloudTokens: number }
    status: "available" | "unavailable" | "stale" | "degraded"
    scope: "local" | "cross-machine"
    error?: string
  }
  externalLocal: UsageSeries & {
    cost: UsageCost
    status: "available" | "unavailable" | "degraded"
    coverage: Array<{
      source: string
      status: "available" | "degraded" | "unavailable" | "unsupported"
      error?: string
    }>
    unclassified: number
    error?: string
  }
  total: UsageSeries
  totalCost: UsageCost
  filterOptions: { claxedo: UsageFilterOptions; total: UsageFilterOptions }
  sync: { attempted: number; delivered: number; conflicts: number; pending: number }
  breakdown?: UsageBreakdownPage
  modelBreakdown?: UsageBreakdownPage
  chart?: UsageChartSeries
}
