export type SessionListSort = "updated_desc" | "created_desc" | "human_turn_desc"

export type SessionOrderKey = {
  updatedAt: number
  createdAt: number
  lastHumanTurnAt?: number
  sessionRef: string
}

export type SessionOrderColumns = {
  lastHumanTurnAt: string
  createdAt: string
  updatedAt: string
  sessionRef: string
}

export type SessionOrderSql = {
  orderBy: string
  keyset?: { sql: string; params: Array<string | number | null> }
}

/**
 * The ORDER BY and the matching keyset predicate, built from one description of
 * the sort so a page boundary cannot disagree with the order it pages through.
 * Every store that pages the session list (the local projection, the hosted
 * registry, the self-hosted registry) builds its SQL here, so a merge of their
 * pages sees one order.
 *
 * A session nobody has ever prompted has no human turn and sorts below every
 * session that has one, which SQLite's DESC already does. The keyset has to say
 * it explicitly, because `NULL < ?` is NULL rather than true, so a plain
 * comparison would end the listing at the first never-prompted row.
 */
export function sessionOrderSql(
  columns: SessionOrderColumns,
  sort: SessionListSort,
  after: SessionOrderKey | undefined,
): SessionOrderSql {
  const ref = columns.sessionRef
  if (sort === "human_turn_desc") {
    const turn = columns.lastHumanTurnAt
    const created = columns.createdAt
    const orderBy = `${turn} DESC, ${created} DESC, ${ref} DESC`
    if (!after) return { orderBy }
    const humanTurnAt = after.lastHumanTurnAt ?? null
    return {
      orderBy,
      keyset: {
        sql: `(
          (? IS NOT NULL AND ${turn} IS NULL)
          OR ${turn} < ?
          OR (${turn} IS ? AND (${created} < ? OR (${created} = ? AND ${ref} < ?)))
        )`,
        params: [humanTurnAt, humanTurnAt, humanTurnAt, after.createdAt, after.createdAt, after.sessionRef],
      },
    }
  }
  const column = sort === "created_desc" ? columns.createdAt : columns.updatedAt
  const orderBy = `${column} DESC, ${ref} DESC`
  if (!after) return { orderBy }
  const at = sort === "created_desc" ? after.createdAt : after.updatedAt
  return {
    orderBy,
    keyset: {
      sql: `(${column} < ? OR (${column} = ? AND ${ref} < ?))`,
      params: [at, at, after.sessionRef],
    },
  }
}
