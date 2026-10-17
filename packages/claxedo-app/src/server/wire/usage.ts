import { isRecord, nonEmptyString } from "@claxedo/helpers/guards"
import type { CredentialSpend, MachineTimeProvider as MachineTimeProviderWire, MachineTimeRate, MachineTimeResponse, MachineTimeWorkspace as MachineTimeWorkspaceWire } from "@claxedo/usage-contract"
import { contractMismatch } from "../errors"
import { placementId, projectId } from "../ids"
import type { AccountSpend, AccountSpendPayer, AccountSpendReport, AccountSpendScope, MachineRate, MachineTime, MachineTimeProvider, MachineTimeWorkspace, SpentAccount, UsageSummary } from "../usage-types"

const MACHINE_TIME_FIELDS = ["since", "until", "activeMs", "running"] as const satisfies readonly (keyof MachineTimeResponse)[]

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isMachineTime(value: unknown): value is MachineTimeResponse {
  return isRecord(value) && MACHINE_TIME_FIELDS.every((field) => finite(value[field])) && Array.isArray(value.workspaces) && Array.isArray(value.providers)
}

function isRate(value: unknown): value is MachineTimeRate {
  return isRecord(value) && nonEmptyString(value.size) !== undefined && finite(value.vcpu) && finite(value.memoryGb) && finite(value.usdPerHour)
}

function rateFromWire(rate: MachineTimeRate): MachineRate {
  return { size: rate.size, vcpu: rate.vcpu, memoryGb: rate.memoryGb, usdPerHour: rate.usdPerHour }
}

function isWorkspace(value: unknown): value is MachineTimeWorkspaceWire {
  return isRecord(value) && nonEmptyString(value.workspaceId) !== undefined && nonEmptyString(value.provider) !== undefined
    && nonEmptyString(value.providerLabel) !== undefined && finite(value.activeMs)
    && (value.rate === undefined) === (value.costUsd === undefined) && (value.rate === undefined || (isRate(value.rate) && finite(value.costUsd)))
}

function workspaceFromWire(row: MachineTimeWorkspaceWire): MachineTimeWorkspace {
  const project = nonEmptyString(row.projectId)
  const name = nonEmptyString(row.name)
  const branch = nonEmptyString(row.branch)
  const machineClass = nonEmptyString(row.machineClass)
  return {
    id: placementId(row.workspaceId),
    ...(project ? { projectId: projectId(project) } : {}),
    ...(name && name !== row.workspaceId ? { name } : {}),
    ...(branch ? { branch } : {}),
    provider: row.provider,
    providerLabel: row.providerLabel,
    ...(machineClass ? { machineClass } : {}),
    activeMs: row.activeMs,
    ...(finite(row.runningSince) ? { runningSince: row.runningSince } : {}),
    ...(finite(row.lastStoppedAt) ? { lastStoppedAt: row.lastStoppedAt } : {}),
    ...(row.rate && row.costUsd !== undefined ? { rate: rateFromWire(row.rate), costUsd: row.costUsd } : {}),
  }
}

function isProvider(value: unknown): value is MachineTimeProviderWire {
  return isRecord(value) && nonEmptyString(value.provider) !== undefined && nonEmptyString(value.label) !== undefined
    && nonEmptyString(value.meter) !== undefined && isRecord(value.source) && nonEmptyString(value.source.url) !== undefined && nonEmptyString(value.source.readOn) !== undefined
}

function providerFromWire(provider: MachineTimeProviderWire): MachineTimeProvider {
  const excludes = nonEmptyString(provider.excludes)
  return { provider: provider.provider, label: provider.label, meter: provider.meter, source: { url: provider.source.url, readOn: provider.source.readOn }, ...(excludes ? { excludes } : {}) }
}

export function machineTimeFromWire(body: unknown): MachineTime {
  if (!isMachineTime(body) || !body.workspaces.every(isWorkspace) || !body.providers.every(isProvider)) throw contractMismatch("machine time")
  return {
    since: body.since,
    until: body.until,
    activeMs: body.activeMs,
    running: body.running,
    workspaces: body.workspaces.map(workspaceFromWire),
    providers: body.providers.map(providerFromWire),
  }
}

const SPEND_FIGURES = ["turnCount", "input", "output", "reasoning", "cacheRead", "cacheWrite", "unknownCategories", "estimatedUsd", "pricedTokens", "unpricedTokens"] as const satisfies readonly (keyof CredentialSpend)[]

const SPEND_COUNTS = ["partialTurnCount", "unavailableTurnCount", "errorTurnCount"] as const satisfies readonly (keyof CredentialSpend)[]

const ACCESS: Readonly<Record<NonNullable<CredentialSpend["kind"]>, SpentAccount["access"]>> = {
  api_key: "apiKey",
  oauth_token: "plan",
  subscription_session: "plan",
}

const SCOPES: readonly AccountSpendScope[] = ["mine", "org"]

function spentAccount(row: Record<string, unknown>): SpentAccount | undefined {
  const accountId = nonEmptyString(row.credentialId)
  const kind = Object.keys(ACCESS).find((name): name is keyof typeof ACCESS => name === row.kind)
  if (!accountId || !kind) return undefined
  const label = nonEmptyString(row.label)
  const providerId = nonEmptyString(row.providerId)
  return { accountId, access: ACCESS[kind], ...(label ? { label } : {}), ...(providerId ? { providerId } : {}) }
}

function payerFromWire(row: Record<string, unknown>): AccountSpendPayer | undefined {
  switch (row.source) {
    case "personal":
    case "org": {
      const account = spentAccount(row)
      return account && { kind: row.source === "org" ? "team" : "own", ...account }
    }
    case "other_member":
      return { kind: "otherMember" }
    case "machine":
    case "unresolved":
    case "unreported":
      return { kind: row.source }
    default:
      return undefined
  }
}

function spendFromWire(row: unknown): AccountSpend {
  if (!isRecord(row) || !SPEND_FIGURES.every((field) => finite(row[field])) || !SPEND_COUNTS.every((field) => row[field] === undefined || finite(row[field]))) throw contractMismatch("spend per account")
  const payer = payerFromWire(row)
  if (!payer) throw contractMismatch("spend per account")
  const counts = Object.fromEntries(SPEND_COUNTS.flatMap((field) => (finite(row[field]) ? [[field, row[field]]] : [])))
  const figure = (field: (typeof SPEND_FIGURES)[number]) => Number(row[field])
  return {
    payer,
    totals: {
      turnCount: figure("turnCount"),
      input: figure("input"),
      output: figure("output"),
      reasoning: figure("reasoning"),
      cacheRead: figure("cacheRead"),
      cacheWrite: figure("cacheWrite"),
      unknownCategories: figure("unknownCategories"),
      ...counts,
    },
    cost: { estimatedUsd: figure("estimatedUsd"), pricedTokens: figure("pricedTokens"), unpricedTokens: figure("unpricedTokens") },
  }
}

export function accountSpendFromWire(body: unknown): AccountSpendReport {
  if (!isRecord(body) || !finite(body.since) || !finite(body.until) || !Array.isArray(body.credentials)) throw contractMismatch("spend per account")
  const scope = SCOPES.find((name) => name === body.scope)
  if (!scope) throw contractMismatch("spend per account")
  return { since: body.since, until: body.until, scope, accounts: body.credentials.map(spendFromWire) }
}

function isUsageSummary(value: unknown): value is UsageSummary {
  return isRecord(value) && value.version === 1 && isRecord(value.range) && isRecord(value.quota) && isRecord(value.claxedo) && isRecord(value.filterOptions)
}

export function usageSummaryFromWire(body: unknown): UsageSummary {
  if (!isUsageSummary(body)) throw contractMismatch("usage")
  return body
}
