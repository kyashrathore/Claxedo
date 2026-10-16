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
  /** `unavailable`: every turn in the row reported no token usage, so its zero tokens are not a measurement. */
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

export {
  CODEX_WINDOW_NAME_BY_SECONDS,
  USAGE_WINDOW_NAMES,
} from "@claxedo/agent-runtime-contract"

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
   * Where this account can be spent. `cloud` is the narrower question and the
   * only one worth asking: a destination that also needs a fixed companion
   * header cannot go through a sandbox provider's edge, which attaches one
   * header per secret, and a machine login has no value to hand one at all.
   * Absent where the reader could not resolve it.
   */
  deliverable?: { local: boolean; cloud: boolean; reason?: string }
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
  quota: {
    status: "available" | "unavailable"
    snapshot?: QuotaSnapshot
    error?: string
    /**
     * Epoch ms of the earliest moment a refresh will run the checks again.
     * Present only on a refresh the reader answered from its last one because
     * the spacing had not elapsed: without it, figures that did not move are
     * indistinguishable from a refresh that ran and found nothing changed.
     */
    throttledUntil?: number
    /**
     * Present while a read of some source is still running: the snapshot is
     * what the earlier reads left behind, and `usage.quota.changed` on
     * `cp/events` rings as each source lands.
     */
    refreshing?: true
  }
  claxedo: UsageSeries & {
    cost: UsageCost
    locationShare: { localTokens: number; cloudTokens: number }
    status: "available" | "unavailable" | "degraded"
    scope: "local" | "cross-machine"
    error?: string
  }
  filterOptions: { claxedo: UsageFilterOptions }
  breakdown?: UsageBreakdownPage
  modelBreakdown?: UsageBreakdownPage
  chart?: UsageChartSeries
}

/**
 * What paid for a turn: `personal`, an account of the reader's own; `org`, the
 * organization's team key; `other_member`, another person's own account the
 * reader's turns spent on a session shared with them, named by nothing of
 * theirs; `machine`, a harness's own login, which is no credential Claxedo
 * holds; `unresolved`, a stored account the turn could not have spent or that
 * no longer exists; `unreported`, nothing the runtime named.
 */
export type CredentialSpendSource = "personal" | "org" | "other_member" | "machine" | "unresolved" | "unreported"

export type CredentialSpend = UsageTotals & {
  source: CredentialSpendSource
  /** Present for `personal` and `org`, with `kind`. */
  credentialId?: string
  kind?: "api_key" | "oauth_token" | "subscription_session"
  /** The name and provider the stored row carries now; absent once the row is deleted. */
  label?: string
  providerId?: string
  estimatedUsd: number
  pricedTokens: number
  unpricedTokens: number
}

/**
 * Cloud turns' spend per credential in [since, until]. `mine`: every turn on
 * the reader's own accounts, whoever sent it, and the reader's own turns on
 * anything else. `org`: every member's turns on the organization's team keys,
 * answered to its owners and admins alone.
 */
export type CredentialSpendResponse = {
  since: number
  until: number
  scope: "mine" | "org"
  credentials: CredentialSpend[]
}

/** The provider's rate for the machine a workspace ran on, from its published pricing. */
export type MachineTimeRate = {
  /** The provider's own name for the size. */
  size: string
  vcpu: number
  memoryGb: number
  usdPerHour: number
}

/**
 * One cloud workspace's machine time on one provider and size in the period. A workspace resized within the period
 * is two rows, each priced at its own rate.
 */
export type MachineTimeWorkspace = {
  workspaceId: string
  projectId?: string
  name?: string
  branch?: string
  provider: string
  providerLabel: string
  machineClass: string | null
  activeMs: number
  /** Set while an epoch is still serving: when it started. */
  runningSince?: number
  /** When this workspace's latest boot in the period ended on this provider and size, where one did. */
  lastStoppedAt?: number
  /** Absent where the provider's rate for this size is not established; then `costUsd` is absent too. */
  rate?: MachineTimeRate
  costUsd?: number
}

/** How one provider bills the time this period counted on it, with where and when its rates were read. */
export type MachineTimeProvider = {
  provider: string
  label: string
  meter: string
  source: { url: string; readOn: string }
  excludes?: string
}

/**
 * The signed person's cloud machine time in [since, until]: the boots of their own cloud workspaces that ended in the
 * range, clipped to it, and those still serving, counted to `until`. `running` is how many are still serving, and
 * `workspaces` splits the same time per workspace, provider and size with the provider's published rate where one is
 * established. `providers` describes the billing of every provider among the rows that has a published rate.
 */
export type MachineTimeResponse = {
  since: number
  until: number
  activeMs: number
  running: number
  workspaces: MachineTimeWorkspace[]
  providers: MachineTimeProvider[]
}
