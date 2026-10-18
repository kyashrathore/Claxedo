export const ENVIRONMENTS = [
  { id: "dev", title: "Development" },
  { id: "staging", title: "Staging" },
  { id: "prod", title: "Production" },
] as const

export type EnvId = (typeof ENVIRONMENTS)[number]["id"]

export const SEGMENTS = [
  { id: "internal", label: "Internal" },
  { id: "beta", label: "Beta testers" },
  { id: "eu", label: "EU" },
  { id: "us", label: "US" },
  { id: "enterprise", label: "Enterprise" },
  { id: "mobile", label: "Mobile" },
] as const

export const TEAMS = [
  { id: "payments", label: "Payments" },
  { id: "growth", label: "Growth" },
  { id: "platform", label: "Platform" },
  { id: "search", label: "Search" },
  { id: "mobile", label: "Mobile" },
] as const

export const FLAG_KEY_PATTERN = "^[a-z][a-z0-9-]+$"
const FLAG_KEY = new RegExp(FLAG_KEY_PATTERN)
export const ROLLOUT_STEP = 5

export type FlagSetting = { readonly enabled: boolean; readonly rollout: number; readonly segments: readonly string[] }

export type AppliedSetting = FlagSetting & { readonly changedAt: string; readonly changedBy: string }

export type Flag = {
  readonly key: string
  readonly description: string
  readonly owner: string
  readonly createdAt: string
  readonly envs: Readonly<Record<EnvId, AppliedSetting>>
}

export type Staged = Readonly<Record<EnvId, Readonly<Record<string, FlagSetting>>>>

export type AuditEntry = { readonly at: string; readonly env: EnvId | "all"; readonly key: string; readonly change: string; readonly actor: string }

export type FlagStore = { readonly flags: readonly Flag[]; readonly staged: Staged; readonly audit: readonly AuditEntry[] }

export type Change = { readonly env: EnvId; readonly key: string; readonly before: FlagSetting; readonly after: FlagSetting }

export const NO_STAGED: Staged = { dev: {}, staging: {}, prod: {} }

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value))
}

export function envTitle(env: EnvId | "all"): string {
  return env === "all" ? "All" : (ENVIRONMENTS.find((entry) => entry.id === env)?.title ?? env)
}

export function teamLabel(id: string): string {
  return TEAMS.find((team) => team.id === id)?.label ?? id
}

export function segmentLabel(id: string): string {
  return SEGMENTS.find((segment) => segment.id === id)?.label ?? id
}

export function isEnvId(value: unknown): value is EnvId {
  return ENVIRONMENTS.some((env) => env.id === value)
}

export function normalizeSetting(raw: unknown, fallback: FlagSetting): FlagSetting {
  const input = record(raw)
  const enabled = typeof input.enabled === "boolean" ? input.enabled : fallback.enabled
  const numeric = typeof input.rollout === "number" ? input.rollout : typeof input.rollout === "string" ? Number(input.rollout) : Number.NaN
  const rollout = Number.isFinite(numeric) ? Math.min(100, Math.max(0, Math.round(numeric / ROLLOUT_STEP) * ROLLOUT_STEP)) : fallback.rollout
  const chosen = input.segments
  const segments = Array.isArray(chosen) ? SEGMENTS.map((segment) => segment.id).filter((id) => chosen.includes(id)) : fallback.segments
  return { enabled, rollout, segments }
}

export function sameSetting(a: FlagSetting, b: FlagSetting): boolean {
  return a.enabled === b.enabled && a.rollout === b.rollout && a.segments.length === b.segments.length && a.segments.every((segment, index) => b.segments[index] === segment)
}

function plain(setting: FlagSetting): FlagSetting {
  return { enabled: setting.enabled, rollout: setting.rollout, segments: [...setting.segments] }
}

export function effectiveSetting(store: FlagStore, env: EnvId, flag: Flag): FlagSetting {
  return store.staged[env][flag.key] ?? plain(flag.envs[env])
}

export function stageEdits(store: FlagStore, env: EnvId, rows: unknown): FlagStore {
  if (!Array.isArray(rows)) return store
  const staged = { ...store.staged[env] }
  for (const row of rows) {
    const key = record(row).key
    const flag = store.flags.find((entry) => entry.key === key)
    if (!flag) continue
    const next = normalizeSetting(row, effectiveSetting(store, env, flag))
    if (sameSetting(next, flag.envs[env])) delete staged[flag.key]
    else staged[flag.key] = next
  }
  return { ...store, staged: { ...store.staged, [env]: staged } }
}

export function unstage(store: FlagStore, env: EnvId, key: string): FlagStore {
  const { [key]: _dropped, ...rest } = store.staged[env]
  return { ...store, staged: { ...store.staged, [env]: rest } }
}

export function revertPending(store: FlagStore): FlagStore {
  return { ...store, staged: NO_STAGED }
}

export function pendingChanges(store: FlagStore): readonly Change[] {
  const changes: Change[] = []
  for (const env of ENVIRONMENTS) {
    for (const flag of store.flags) {
      const after = store.staged[env.id][flag.key]
      if (after && !sameSetting(after, flag.envs[env.id])) changes.push({ env: env.id, key: flag.key, before: plain(flag.envs[env.id]), after })
    }
  }
  return changes
}

export function changeStat(changes: readonly Change[]): { readonly additions: number; readonly deletions: number; readonly updates: number } {
  let additions = 0
  let deletions = 0
  let updates = 0
  for (const change of changes) {
    if (!change.before.enabled && change.after.enabled) additions += 1
    else if (change.before.enabled && !change.after.enabled) deletions += 1
    else updates += 1
  }
  return { additions, deletions, updates }
}

export function audienceLabel(setting: FlagSetting): string {
  if (!setting.enabled) return "Off"
  const who = setting.segments.length === 0 ? "everyone" : setting.segments.map(segmentLabel).join(", ")
  return `${setting.rollout}% of ${who}`
}

export function describeChange(change: Change): string {
  const parts: string[] = []
  if (change.before.enabled !== change.after.enabled) parts.push(change.after.enabled ? "enabled" : "disabled")
  if (change.before.rollout !== change.after.rollout) parts.push(`rollout ${change.before.rollout}% → ${change.after.rollout}%`)
  const added = change.after.segments.filter((segment) => !change.before.segments.includes(segment))
  const removed = change.before.segments.filter((segment) => !change.after.segments.includes(segment))
  if (added.length > 0) parts.push(`targeting +${added.map(segmentLabel).join(", +")}`)
  if (removed.length > 0) parts.push(`targeting −${removed.map(segmentLabel).join(", −")}`)
  return parts.join(", ")
}

export function promotionWarnings(store: FlagStore, changes: readonly Change[]): readonly string[] {
  return changes
    .filter((change) => change.env === "prod" && change.after.enabled && !change.before.enabled)
    .filter((change) => {
      const flag = store.flags.find((entry) => entry.key === change.key)
      return flag !== undefined && !effectiveSetting(store, "staging", flag).enabled
    })
    .map((change) => `${change.key} turns on in Production while it is off in Staging.`)
}

function diffLine(sign: "-" | "+", change: Change, setting: FlagSetting): string {
  return `${sign} ${change.env.padEnd(8)}${change.key.padEnd(30)}${audienceLabel(setting)}`
}

export function pendingMarkdown(store: FlagStore, changes: readonly Change[]): string {
  if (changes.length === 0) return "Nothing is staged. Edit a switch, slider or targeting chip, then press **Stage edits**."
  const stat = changeStat(changes)
  const envs = ENVIRONMENTS.filter((env) => changes.some((change) => change.env === env.id)).map((env) => env.title)
  const lines = [
    `**${changes.length} change${changes.length === 1 ? "" : "s"}** across ${envs.join(", ")}: ${stat.additions} enabled, ${stat.deletions} disabled, ${stat.updates} retargeted.`,
    "",
    ...changes.map((change) => `- \`${change.key}\` in ${envTitle(change.env)}: ${describeChange(change)}`),
  ]
  const warnings = promotionWarnings(store, changes)
  if (warnings.length > 0) lines.push("", ...warnings.map((warning) => `> ⚠ ${warning}`))
  lines.push("", "```diff", ...changes.flatMap((change) => [diffLine("-", change, change.before), diffLine("+", change, change.after)]), "```")
  return lines.join("\n")
}

export function applyPending(store: FlagStore, now: string, actor: string): { readonly store: FlagStore; readonly applied: readonly Change[] } {
  const applied = pendingChanges(store)
  if (applied.length === 0) return { store, applied }
  const flags = store.flags.map((flag) => {
    const mine = applied.filter((change) => change.key === flag.key)
    if (mine.length === 0) return flag
    const envs = { ...flag.envs }
    for (const change of mine) envs[change.env] = { ...plain(change.after), changedAt: now, changedBy: actor }
    return { ...flag, envs }
  })
  const entries = applied.map((change): AuditEntry => ({ at: now, env: change.env, key: change.key, change: describeChange(change), actor }))
  return { store: { flags, staged: NO_STAGED, audit: [...entries, ...store.audit] }, applied }
}

export function killSwitch(store: FlagStore, env: EnvId, now: string, actor: string): { readonly store: FlagStore; readonly disabled: readonly string[] } {
  const disabled = store.flags.filter((flag) => flag.envs[env].enabled).map((flag) => flag.key)
  const flags = store.flags.map((flag) =>
    flag.envs[env].enabled ? { ...flag, envs: { ...flag.envs, [env]: { ...flag.envs[env], enabled: false, changedAt: now, changedBy: actor } } } : flag,
  )
  const entry: AuditEntry = {
    at: now,
    env,
    key: disabled.length === 0 ? "(none)" : `${disabled.length} flag${disabled.length === 1 ? "" : "s"}`,
    change: `kill switch: disabled ${disabled.join(", ") || "nothing, all flags were already off"}`,
    actor,
  }
  return { store: { flags, staged: { ...store.staged, [env]: {} }, audit: [entry, ...store.audit] }, disabled }
}

export type FlagDraft = { readonly key: string; readonly description: string; readonly owner: string }

export function validateFlagDraft(store: FlagStore, value: unknown): { ok: true; draft: FlagDraft } | { ok: false; error: string } {
  const input = record(value)
  const key = typeof input.key === "string" ? input.key.trim() : ""
  if (!FLAG_KEY.test(key)) return { ok: false, error: "A flag key starts with a lowercase letter and uses only lowercase letters, digits and hyphens, at least 2 characters." }
  if (key.length > 64) return { ok: false, error: "Keep the flag key to 64 characters." }
  if (key.endsWith("-") || key.includes("--")) return { ok: false, error: "A flag key cannot end with a hyphen or contain two in a row." }
  if (store.flags.some((flag) => flag.key === key)) return { ok: false, error: `A flag named ${key} already exists.` }
  const description = typeof input.description === "string" ? input.description.trim() : ""
  if (description.length < 8) return { ok: false, error: "Describe what the flag gates in at least 8 characters." }
  const chosen: unknown = Array.isArray(input.owner) ? input.owner[0] : input.owner
  const owner = TEAMS.find((team) => team.id === chosen)
  if (!owner) return { ok: false, error: "Choose the owning team." }
  return { ok: true, draft: { key, description, owner: owner.id } }
}

export function createFlag(store: FlagStore, draft: FlagDraft, now: string, actor: string): FlagStore {
  const off: AppliedSetting = { enabled: false, rollout: 0, segments: [], changedAt: now, changedBy: actor }
  const flag: Flag = { ...draft, createdAt: now, envs: { dev: off, staging: off, prod: off } }
  const entry: AuditEntry = { at: now, env: "all", key: draft.key, change: `created, owned by ${teamLabel(draft.owner)}, off everywhere`, actor }
  return { ...store, flags: [...store.flags, flag], audit: [entry, ...store.audit] }
}

export function searchFlags(flags: readonly Flag[], query: string): readonly Flag[] {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0)
  if (terms.length === 0) return flags
  return flags.filter((flag) => {
    const haystack = [flag.key, flag.description, teamLabel(flag.owner), ...ENVIRONMENTS.flatMap((env) => flag.envs[env.id].segments.map(segmentLabel))].join(" ").toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}

export function envSummary(store: FlagStore, env: EnvId): { readonly on: number; readonly total: number; readonly pending: number } {
  return {
    on: store.flags.filter((flag) => flag.envs[env].enabled).length,
    total: store.flags.length,
    pending: pendingChanges(store).filter((change) => change.env === env).length,
  }
}

export function seedFlags(now: Date): FlagStore {
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString()
  const setting = (enabled: boolean, rollout: number, segments: string[], days: number, by: string): AppliedSetting => ({ enabled, rollout, segments, changedAt: ago(days), changedBy: by })
  const flag = (key: string, owner: string, description: string, created: number, dev: AppliedSetting, staging: AppliedSetting, prod: AppliedSetting): Flag => ({
    key,
    owner,
    description,
    createdAt: ago(created),
    envs: { dev, staging, prod },
  })
  return {
    staged: NO_STAGED,
    audit: [
      { at: ago(1), env: "prod", key: "checkout-v2", change: "rollout 5% → 10%", actor: "Ana Ruiz" },
      { at: ago(2), env: "staging", key: "recommendations-carousel", change: "enabled, rollout 0% → 25%", actor: "Kenji Sato" },
      { at: ago(4), env: "prod", key: "search-typo-tolerance", change: "rollout 25% → 50%", actor: "Lena Fischer" },
    ],
    flags: [
      flag("checkout-v2", "payments", "Single-page checkout with saved wallets and inline address validation.", 40,
        setting(true, 100, [], 30, "Ana Ruiz"), setting(true, 50, ["internal", "beta"], 9, "Ana Ruiz"), setting(true, 10, ["beta"], 1, "Ana Ruiz")),
      flag("new-search-ranking", "search", "Learning-to-rank model replaces BM25 ordering on the results page.", 25,
        setting(true, 100, [], 20, "Lena Fischer"), setting(true, 100, [], 6, "Lena Fischer"), setting(false, 0, [], 25, "Lena Fischer")),
      flag("dark-mode-default", "platform", "New accounts start in the dark theme.", 90,
        setting(true, 100, [], 80, "Omar Haddad"), setting(true, 100, [], 70, "Omar Haddad"), setting(true, 100, [], 60, "Omar Haddad")),
      flag("one-click-reorder", "growth", "Reorder a past basket from the order history in one tap.", 12,
        setting(true, 100, [], 10, "Kenji Sato"), setting(false, 0, [], 12, "Kenji Sato"), setting(false, 0, [], 12, "Kenji Sato")),
      flag("eu-vat-invoices", "payments", "Issue VAT-compliant invoices for EU business customers.", 120,
        setting(true, 100, ["eu"], 100, "Ana Ruiz"), setting(true, 100, ["eu"], 95, "Ana Ruiz"), setting(true, 100, ["eu"], 90, "Ana Ruiz")),
      flag("mobile-push-digest", "mobile", "Daily digest push notification instead of one push per event.", 8,
        setting(true, 50, ["mobile"], 7, "Priya Das"), setting(false, 0, [], 8, "Priya Das"), setting(false, 0, [], 8, "Priya Das")),
      flag("recommendations-carousel", "growth", "Personalized carousel on the home page.", 30,
        setting(true, 100, [], 28, "Kenji Sato"), setting(true, 25, [], 2, "Kenji Sato"), setting(true, 5, ["us"], 14, "Kenji Sato")),
      flag("graphql-gateway", "platform", "Route storefront reads through the GraphQL gateway.", 45,
        setting(true, 100, [], 40, "Omar Haddad"), setting(true, 100, ["internal"], 15, "Omar Haddad"), setting(false, 0, [], 45, "Omar Haddad")),
      flag("enterprise-sso-enforcement", "platform", "Require SAML sign-in for enterprise workspaces.", 60,
        setting(true, 100, [], 55, "Omar Haddad"), setting(true, 100, ["enterprise"], 50, "Omar Haddad"), setting(true, 100, ["enterprise"], 21, "Omar Haddad")),
      flag("instant-refunds", "payments", "Refund to the original card without manual review under 50 EUR.", 5,
        setting(true, 100, [], 4, "Ana Ruiz"), setting(false, 0, [], 5, "Ana Ruiz"), setting(false, 0, [], 5, "Ana Ruiz")),
      flag("search-typo-tolerance", "search", "Fuzzy matching for queries with up to two typos.", 50,
        setting(true, 100, [], 45, "Lena Fischer"), setting(true, 100, [], 30, "Lena Fischer"), setting(true, 50, [], 4, "Lena Fischer")),
      flag("legacy-cart-fallback", "platform", "Serve the legacy cart when the new cart service errors.", 200,
        setting(true, 100, [], 180, "Omar Haddad"), setting(true, 100, [], 180, "Omar Haddad"), setting(true, 100, ["internal"], 33, "Omar Haddad")),
    ],
  }
}
