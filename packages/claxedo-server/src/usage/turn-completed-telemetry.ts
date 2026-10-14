import type { ControlPlaneTelemetry } from "@claxedo/server-core/platform/telemetry/ports"
import type { TurnUsageRevision } from "@claxedo/server-core/usage/contracts"
import type { UsageReportWriter } from "@claxedo/server-core/usage/usage-report"

const TOKEN_BUCKETS = [
  [1_000, "<1k"],
  [10_000, "1k-10k"],
  [100_000, "10k-100k"],
  [1_000_000, "100k-1m"],
] as const

export function tokensBucket(tokens: TurnUsageRevision["tokens"]): string {
  const counts = [tokens.input, tokens.output, tokens.reasoning].filter((count): count is number => count !== null)
  if (!counts.length) return "unknown"
  const total = counts.reduce((sum, count) => sum + count, 0)
  return TOKEN_BUCKETS.find(([limit]) => total < limit)?.[1] ?? ">=1m"
}

export function modelFamily(modelId: string): string {
  const name = modelId.toLowerCase().split("/").at(-1) ?? ""
  const words = name.split("-")
  const firstVersioned = words.findIndex((word) => /\d/.test(word))
  const leading = (firstVersioned === -1 ? words : words.slice(0, firstVersioned)).slice(0, 2)
  return leading.length ? leading.join("-") : "other"
}

/**
 * `turn_completed` for each settled usage row the plane files: one per message
 * a harness reports for a turn, so a turn of several model calls reads as
 * several rows. A provisional or still-running revision is not settled, and a
 * replayed one (anything but `accepted`) was already counted. The durations
 * are measured from the turn's admission, so a row filed under another turn's
 * lease carries none.
 */
export function withTurnCompletedTelemetry(writer: UsageReportWriter, telemetry: ControlPlaneTelemetry): UsageReportWriter {
  return {
    async writeRevision(fact, filing) {
      const result = await writer.writeRevision(fact, filing)
      if (result.status !== "accepted" || fact.settlement === "provisional" || fact.status === "running") return result
      const sinceAdmission = (at: number | undefined) =>
        at !== undefined && filing.admittedAt !== undefined ? Math.max(0, at - filing.admittedAt) : undefined
      const duration = sinceAdmission(fact.completedAt)
      const firstToken = sinceAdmission(fact.firstOutputAt)
      telemetry.capture(filing.owner.user_id, "turn_completed", {
        harness: fact.harness,
        model_family: modelFamily(fact.modelId),
        outcome: fact.status,
        ...(fact.status === "error" && fact.errorClass ? { error_code: fact.errorClass } : {}),
        settlement: fact.settlement,
        location: fact.location,
        tokens_bucket: tokensBucket(fact.tokens),
        ...(duration === undefined ? {} : { duration_ms: duration }),
        ...(firstToken === undefined ? {} : { first_token_ms: firstToken }),
        ...(fact.workspaceId ? { workspace_id: fact.workspaceId } : {}),
        org_id: filing.owner.org_id,
        $groups: { org: filing.owner.org_id },
      })
      return result
    },
  }
}
