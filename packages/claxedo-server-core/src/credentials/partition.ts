/**
 * The named single-tenant credential partition.
 *
 * An unsigned local deployment has no organization concept, so its
 * credentials live in ONE explicitly named partition rather than in an
 * implicit "no org = everything" wildcard. Every query in the registry is
 * `WHERE org_id = <scope>`; a caller that resolves no org resolves to THIS
 * value, so a missed call site can only fail closed (it sees the single-tenant
 * partition) — it can never widen into another tenant's rows.
 *
 * Value matches the `__local__` sentinel `routes/documents.ts` already uses for
 * the same loopback/unsigned case, so the two org-scoped surfaces read alike.
 */
export const SINGLE_TENANT_ORG = "__local__"
