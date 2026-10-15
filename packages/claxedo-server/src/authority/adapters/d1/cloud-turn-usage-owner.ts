import type { D1Database } from "@cloudflare/workers-types"

/**
 * The account a cloud workspace turn's usage is filed under: the person whose
 * actor produced the turn. An agent actor has no account, and a deleted
 * session or workspace answers for no one: each leaves the usage unowned
 * rather than guessed.
 */
export async function readD1CloudTurnUsageOwner(database: D1Database, sessionId: string, turnId: string) {
  const turn = await database.prepare(`
    select source.org_id, actor.user_id from session_turn_producers source
    join actors actor on actor.actor_id = source.actor_id and actor.user_id is not null
    join sessions session on session.session_id = source.session_id and session.deleted_at is null
    join workspaces workspace on workspace.workspace_id = source.workspace_id
      and workspace.deleted_at is null and workspace.backing = 'cloud-vm'
    where source.session_id = ? and source.turn_id = ?
  `).bind(sessionId, turnId).first<{ org_id: string; user_id: string }>()
  return turn ?? undefined
}
