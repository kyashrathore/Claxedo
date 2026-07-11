import { authFetch, getClaxedoServerUrl, normalizeUrl } from "@/shared/data/api"

// Mirrors claxedo-server's tokentracker-cli snapshot (server-usage-limits.ts).
// Each provider is either absent-of-config or a live/errored window set.

export type UsageWindow = {
  used_percent?: number
  utilization?: number
  // Providers are inconsistent: Claude uses `resets_at`, Cursor uses `reset_at`.
  resets_at?: string | null
  reset_at?: string | null
  label?: string
}

export type UsageProvider = {
  configured: boolean
  error?: string | null
  plan_label?: string | null
  stale?: boolean
  cached_at?: string | null
  retry_at?: string | null
  auth_action_required?: string
  // Claude windows
  five_hour?: UsageWindow | null
  seven_day?: UsageWindow | null
  seven_day_opus?: UsageWindow | null
  weekly_scoped?: Array<{ label: string; utilization: number; resets_at: string | null }> | null
  // Codex / others
  primary_window?: UsageWindow | null
  secondary_window?: UsageWindow | null
  credit_window?: UsageWindow | null
} & Record<string, unknown>

export type UsageLimitsSnapshot = {
  fetched_at: string
} & Record<string, UsageProvider | string>

// The provider keys tokentracker exposes, in the order we render them.
export const USAGE_PROVIDERS = [
  "claude",
  "codex",
  "copilot",
  "gemini",
  "cursor",
  "kimi",
  "grok",
  "zcode",
  "kiro",
  "antigravity",
  "opencodeGo",
] as const

export const USAGE_PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "Copilot",
  gemini: "Gemini",
  cursor: "Cursor",
  kimi: "Kimi",
  grok: "Grok",
  zcode: "ZCode",
  kiro: "Kiro",
  antigravity: "Antigravity",
  opencodeGo: "OpenCode",
}

const UsageLimitsRoute = "/api/claxedo/usage-limits"

function url(refresh = false) {
  const serverUrl = getClaxedoServerUrl()
  const target = new URL(UsageLimitsRoute, normalizeUrl(serverUrl) ?? serverUrl)
  if (refresh) target.searchParams.set("refresh", "1")
  return String(target)
}

export async function fetchUsageLimits(input?: { refresh?: boolean }): Promise<UsageLimitsSnapshot> {
  const res = await authFetch(url(input?.refresh))
  if (!res.ok) throw new Error((await res.text()) || `Request failed: ${res.status}`)
  return res.json()
}
