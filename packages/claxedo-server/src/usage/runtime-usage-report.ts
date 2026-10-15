import type { Context } from "hono"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { TurnUsageRevision, UsageOwner } from "@claxedo/server-core/usage/contracts"
import {
  cloudWorkspaceUsageRevision,
  readUsageReportFacts,
  usageReportAnswer,
  usageReportFactInBounds,
  type UsageReportFact,
  type UsageReportResult,
  type UsageReportWriter,
} from "@claxedo/server-core/usage/usage-report"
import { trimToUndefined } from "@claxedo/helpers/string"
import { SESSION_TURN_GRANT_DEFAULT_TTL_MS } from "@claxedo/server-core/platform/auth/session-turn-authority"
import type { SessionProofClaims, TurnLeaseClaims } from "../session/runtime-session-proofs"
import { positiveInteger } from "../session/runtime-authority-request"

const USAGE_REPORT_KEYS: ReadonlySet<string> = new Set(["action", "sessionId", "turnId", "leaseId", "fencingToken", "facts"])

/** How long after its release a turn's usage proof files the usage its work leaves: as long as a deferred turn grant lives. */
export const USAGE_REPORT_TAIL_MS = SESSION_TURN_GRANT_DEFAULT_TTL_MS

export type RuntimeUsageReportInput = {
  verifyTurnLease: (lease: string) => Promise<TurnLeaseClaims>
  /** The usage proof a turn's release answered, which proves that turn here alone. */
  verifyTurnUsageProof: (proof: string) => Promise<TurnLeaseClaims>
  /** The refusal for a lease whose host is not the one serving the session, or nothing. */
  hostRefusal: (context: Context, lease: TurnLeaseClaims, sessionId: string) => Promise<Response | undefined>
  /** Why the proof the lease was minted from no longer stands, or nothing. */
  proofDenial: (claims: SessionProofClaims) => Promise<{ code: string; message: string } | undefined>
  resolveCloudTurnUsageOwner?: WorkspaceAuthority["resolveCloudTurnUsageOwner"]
  usageWriter?: UsageReportWriter
}

/**
 * A cloud workspace runtime's usage for one session, proven by a turn lease
 * the plane minted for that session. Session and workspace come from the
 * lease, location and host from the plane; the report names none of them.
 * Each fact names the turn it was metered under and is owned by that turn's
 * recorded producer, so a fact retried under a later turn's lease stays its
 * own turn's. A fact is refused alone when it is out of bounds, when its
 * turn is not one a cloud workspace's session admitted for an account, or
 * when its turn already holds the most messages one turn files; a malformed
 * fact, or too many of them, refuses the report.
 * The lease may already be released: it proves the turn was admitted until
 * its own expiry, and the usage proof its release answered proves it for
 * `USAGE_REPORT_TAIL_MS` after, so usage a turn's work leaves once it ended (a
 * background task's report) is filed when it settles. A fact filed under
 * the usage proof carries no admission time, since its turn's duration says
 * nothing about it.
 */
export async function reportRuntimeUsage(context: Context, body: Record<string, unknown>, input: RuntimeUsageReportInput) {
  const sessionId = trimToUndefined(body.sessionId)
  const turnId = trimToUndefined(body.turnId)
  const leaseId = trimToUndefined(body.leaseId)
  const fencingToken = positiveInteger(body.fencingToken)
  const facts = readUsageReportFacts(body.facts)
  if (Object.keys(body).some((key) => !USAGE_REPORT_KEYS.has(key)) || !sessionId || !turnId || !leaseId || !fencingToken || !facts) {
    return context.json(
      { error: { code: "usage_report_invalid", message: "A usage report carries a session turn lease and well-formed facts only" } },
      400,
    )
  }
  const held = await input.verifyTurnLease(leaseId).catch(() => undefined)
  const lease = held ?? await input.verifyTurnUsageProof(leaseId).catch(() => undefined)
  if (!lease || lease.sessionId !== sessionId || lease.turnId !== turnId || lease.fencingToken !== fencingToken) {
    return context.json(
      { error: { code: "session_turn_lease_invalid", message: "Session turn lease is invalid or mismatched" } },
      401,
    )
  }
  const hostRefusal = await input.hostRefusal(context, lease, sessionId)
  if (hostRefusal) return hostRefusal
  let revisions: Array<{ fact: UsageReportFact; revision: TurnUsageRevision }>
  try {
    revisions = facts.map((fact) => ({ fact, revision: cloudWorkspaceUsageRevision(fact, lease) }))
  } catch {
    return context.json({ error: { code: "usage_report_invalid", message: "A reported usage revision is malformed" } }, 400)
  }
  try {
    const denial = await input.proofDenial(lease)
    if (denial) return context.json({ error: denial }, 401)
    const writer = input.usageWriter
    const resolveOwner = input.resolveCloudTurnUsageOwner
    if (!writer || !resolveOwner) {
      return context.json({ error: { code: "usage_report_unavailable", message: "Usage reporting is not configured" } }, 503)
    }
    const window = { admittedAt: lease.acquiredAt, now: Date.now() }
    const inBounds = revisions.filter(({ fact }) => usageReportFactInBounds(fact, window))
    const owners = new Map<string, UsageOwner | undefined>()
    for (const factTurnId of new Set(inBounds.map(({ fact }) => fact.turnId))) {
      owners.set(factTurnId, await resolveOwner({ sessionId, turnId: factTurnId }))
    }
    const results: UsageReportResult[] = []
    for (const item of revisions) {
      const { fact, revision } = item
      const reported = { messageId: revision.messageId, revision: revision.revision }
      const owner = owners.get(fact.turnId)
      if (!inBounds.includes(item)) results.push({ ...reported, status: "refused", code: "usage_fact_out_of_bounds" })
      else if (!owner) results.push({ ...reported, status: "refused", code: "usage_owner_unresolved" })
      else results.push({ ...reported, ...usageReportAnswer(await writer.writeRevision(revision, { owner, turnId: fact.turnId, ...(held && fact.turnId === lease.turnId ? { admittedAt: lease.acquiredAt } : {}) })) })
    }
    return context.json({ results })
  } catch {
    return context.json(
      { error: { code: "session_authority_unavailable", message: "Session authority is temporarily unavailable" } },
      503,
    )
  }
}
