type Database = {
  exec(sql: string): unknown
  prepare<Row = unknown>(sql: string): {
    run(...params: unknown[]): unknown
    get(...params: unknown[]): Row | null | undefined
  }
}

export class SessionAuthoringOwnership {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS session_prompt_actor (
      session_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      PRIMARY KEY (session_id, actor_id)
    )`)
  }

  record(sessionId: string, actorId?: string) {
    if (actorId) this.db.prepare("INSERT OR IGNORE INTO session_prompt_actor VALUES (?, ?)").run(sessionId, actorId)
  }

  foreignActorInLineage(sessionId: string, ownerActorId?: string): boolean {
    return !!this.db.prepare<{ found: number }>(`
      WITH RECURSIVE lineage(id) AS (
        SELECT ? UNION
        SELECT session.parent_id FROM session JOIN lineage ON session.id = lineage.id WHERE session.parent_id IS NOT NULL
      ), actors(actor_id) AS (
        SELECT actor_id FROM session_prompt_actor WHERE session_id IN (SELECT id FROM lineage)
        UNION
        SELECT json_extract(payload_json, '$.actorId') FROM runtime_journal
        WHERE session_id IN (SELECT id FROM lineage) AND kind = 'control' AND type = 'turn.start'
      )
      SELECT 1 AS found FROM actors WHERE actor_id IS NOT NULL AND actor_id IS NOT ?
      UNION ALL
      SELECT 1 FROM lineage LEFT JOIN session ON session.id = lineage.id WHERE session.id IS NULL
      LIMIT 1
    `).get(sessionId, ownerActorId ?? null)
  }
}
