/**
 * The D1-backed implementation of the Connections kit's `ConnectionStorePort`,
 * partitioned to ONE (org, owner) pair.
 *
 * One instance serves one request: the caller has already resolved the signed
 * principal to an application `user_id` and `org_id` through the workspace
 * authority, and this store never accepts an owner key outside those two
 * partitions. That refusal is the whole security property — the hosted routes
 * run with `ownerlessRows: "refuse"`, so there is no deployment-wide team
 * partition to fall back to and a row can only ever belong to
 * `user:{ownerUserId}` or `org:{orgId}`.
 */
import type { D1Database } from "@cloudflare/workers-types"
import type { ConnectionRow, ConnectionStorePort, IntegrationCapability } from "@claxedo/connections"

export type D1ConnectionStoreInput = Readonly<{
  database: D1Database
  orgId: string
  ownerUserId: string
  /** Write clock. Injected so a test can pin what `updated_at` records. */
  now?: () => number
}>

type ConnectionRecord = {
  connection_id: string
  org_id: string
  owner_user_id: string | null
  integration_id: string
  granted_capabilities_json: string
  fields_json: string
  account_label: string | null
  created_at: number
  updated_at: number
}

const SELECT_COLUMNS = `
  connection_id, org_id, owner_user_id, integration_id,
  granted_capabilities_json, fields_json, account_label, created_at, updated_at
`

/**
 * Atlassian is declared as `atlassian` by the kit and stored as `jira` by every
 * hosted surface that predates it (webhooks route by provider name, and
 * `service.webhookConnection` normalizes the same direction). Keeping the
 * stored value `jira` means a hosted row written before this store still reads
 * back as the same connection; the translation lives here so nothing above the
 * store has to know about it.
 */
const storedIntegrationId = (integrationId: string) => (integrationId === "atlassian" ? "jira" : integrationId)
const kitIntegrationId = (integrationId: string) => (integrationId === "jira" ? "atlassian" : integrationId)

/**
 * A write that would leave this store's two partitions. Never reachable through
 * the kit — `storeConnection` only ever passes back an id it read from this
 * caller's own partition, or a fresh UUID — so reaching it means an invariant
 * broke, not that a user did something ordinary. It is deliberately NOT the
 * conflict below: nothing a caller can retry differently fixes it.
 */
export class HostedConnectionPartitionError extends Error {}

/**
 * A second row for one (org, owner, integration). The kit reuses the existing
 * row's id when it finds one, so this is the RACE: two concurrent connects both
 * read no existing row, both mint a fresh id, and the second trips
 * `hosted_connections_one_per_partition`. That is exactly the state the kit
 * already has a name for, so the setup answers it `connection_exists`/409
 * instead of letting a raw `D1_ERROR` become a 500.
 */
export class HostedConnectionExistsError extends Error {}

/**
 * The partition index is the only unique constraint the upsert can trip — the
 * primary key is handled by its `on conflict` clause — so a unique failure from
 * this statement means a duplicate row for this partition and nothing else.
 */
function isPartitionUniqueViolation(cause: unknown): boolean {
  const text = cause instanceof Error ? `${cause.message} ${String((cause.cause as Error | undefined)?.message ?? "")}` : String(cause)
  return /unique constraint failed/i.test(text)
}

export function createD1ConnectionStore(input: D1ConnectionStoreInput): ConnectionStorePort {
  const now = input.now ?? Date.now
  const personalOwner = `user:${input.ownerUserId}`
  const organizationOwner = `org:${input.orgId}`

  const toRow = (record: ConnectionRecord): ConnectionRow => ({
    id: record.connection_id,
    integrationId: kitIntegrationId(record.integration_id),
    owner: record.owner_user_id ? `user:${record.owner_user_id}` : `org:${record.org_id}`,
    ...(record.account_label ? { accountLabel: record.account_label } : {}),
    grantedCapabilities: JSON.parse(record.granted_capabilities_json) as IntegrationCapability[],
    fields: JSON.parse(record.fields_json) as Record<string, string>,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  })

  /**
   * Every read is scoped to this org AND to the two partitions the caller may
   * see. A connection id is a UUID, but scoping the SQL rather than filtering
   * in TypeScript is what makes a cross-org id unreachable even if a caller
   * guesses one.
   */
  const partitionScope = `org_id = ? and (owner_user_id is null or owner_user_id = ?)`
  const partitionBindings = [input.orgId, input.ownerUserId] as const

  const ownerColumn = (owner: string | undefined) => {
    if (owner === personalOwner) return { ok: true as const, value: input.ownerUserId }
    if (owner === organizationOwner) return { ok: true as const, value: null }
    return { ok: false as const }
  }

  return {
    async upsert(row) {
      const column = ownerColumn(row.owner)
      if (!column.ok) {
        throw new HostedConnectionPartitionError("Hosted Connection owner is outside the authenticated partitions")
      }
      const integrationId = storedIntegrationId(row.integrationId)
      const timestamp = now()
      let result
      try {
        result = await input.database
          .prepare(
            // `connection_id` is the PRIMARY KEY, so the conflict target alone
            // reaches every row in the table — including another org's. The
            // predicate on the update is what keeps this write inside the
            // caller's partition: a colliding id owned elsewhere matches no row
            // to update, changes nothing, and is refused below rather than
            // silently overwriting the victim.
            `
        insert into hosted_connections (
          connection_id, org_id, owner_user_id, integration_id,
          granted_capabilities_json, fields_json, account_label,
          created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict (connection_id) do update set
          integration_id = excluded.integration_id,
          granted_capabilities_json = excluded.granted_capabilities_json,
          fields_json = excluded.fields_json,
          account_label = excluded.account_label,
          updated_at = excluded.updated_at
        where hosted_connections.org_id = excluded.org_id
          and hosted_connections.owner_user_id is excluded.owner_user_id
      `,
          )
          .bind(
            row.id,
            input.orgId,
            column.value,
            integrationId,
            JSON.stringify(row.grantedCapabilities),
            JSON.stringify(row.fields),
            row.accountLabel ?? null,
            row.createdAt,
            timestamp,
          )
          .run()
      } catch (cause) {
        if (isPartitionUniqueViolation(cause)) throw new HostedConnectionExistsError("connection_exists")
        throw cause
      }
      // An insert writes one row and a permitted update changes one row, so the
      // only way to change none is the refused conflict above.
      if ((result.meta.changes ?? 0) === 0) {
        throw new HostedConnectionPartitionError("Hosted Connection id belongs to another organization or owner")
      }
    },

    async get(integrationId, owner) {
      const column = ownerColumn(owner)
      if (!column.ok) return undefined
      const record = await input.database
        .prepare(
          `
        select ${SELECT_COLUMNS}
        from hosted_connections
        where org_id = ? and integration_id = ?
          and ${column.value === null ? "owner_user_id is null" : "owner_user_id = ?"}
      `,
        )
        .bind(
          ...(column.value === null
            ? [input.orgId, storedIntegrationId(integrationId)]
            : [input.orgId, storedIntegrationId(integrationId), column.value]),
        )
        .first<ConnectionRecord>()
      return record ? toRow(record) : undefined
    },

    async getById(id) {
      const record = await input.database
        .prepare(`select ${SELECT_COLUMNS} from hosted_connections where connection_id = ? and ${partitionScope}`)
        .bind(id, ...partitionBindings)
        .first<ConnectionRecord>()
      return record ? toRow(record) : undefined
    },

    async list(filter) {
      // `null` asks for the kit's owner-absent partition, which a refusing host
      // does not have; a foreign owner key belongs to neither of this caller's
      // partitions. Both answer empty rather than leaking the org partition.
      if (filter?.owner === null) return []
      if (filter?.owner !== undefined && filter.owner !== personalOwner && filter.owner !== organizationOwner) return []
      const scope =
        filter?.owner === personalOwner
          ? { clause: "org_id = ? and owner_user_id = ?", bindings: [input.orgId, input.ownerUserId] }
          : filter?.owner === organizationOwner
            ? { clause: "org_id = ? and owner_user_id is null", bindings: [input.orgId] }
            : { clause: partitionScope, bindings: [...partitionBindings] }
      const result = await input.database
        .prepare(`select ${SELECT_COLUMNS} from hosted_connections where ${scope.clause} order by created_at, connection_id`)
        .bind(...scope.bindings)
        .all<ConnectionRecord>()
      return result.results.map(toRow)
    },

    async delete(id) {
      const result = await input.database
        .prepare(`delete from hosted_connections where connection_id = ? and ${partitionScope}`)
        .bind(id, ...partitionBindings)
        .run()
      return (result.meta.changes ?? 0) > 0
    },
  }
}
