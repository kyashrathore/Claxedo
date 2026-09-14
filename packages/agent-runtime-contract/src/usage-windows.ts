/**
 * The Claxedo name for each plan-usage window slot a vendor reports.
 *
 * Data only, and in the contract package because four readers spell the same
 * three windows differently — the HTTP verifier, the Codex app-server
 * self-report, the machine-wide probe and the Claude event adapter — and a
 * window named one way by the writer and another by the reader draws as two
 * plans.
 */

/**
 * Per harness, because one table across vendors would label half of them
 * wrongly: `primary_window` is a session for Codex and the whole billing cycle
 * for Cursor. A harness, or a slot, that is not listed keeps the vendor's own
 * field name — inventing a tier name for it would rot on the next vendor change
 * without anything failing.
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
