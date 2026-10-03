import type { Server, SessionInventoryInput, SessionInventoryPage } from "@/server"

export type InventoryServer = { readonly sessions: Pick<Server["sessions"], "inventory"> }

export async function readInventoryPages(server: InventoryServer, input: SessionInventoryInput, wanted: number): Promise<SessionInventoryPage> {
  let page = await server.sessions.inventory(input)
  const rows = new Map(page.rows.map((row) => [row.ref.sessionId, row]))
  const statuses = new Map(page.statuses)
  const cursors = new Set<string>()
  let degraded = page.degraded === true
  while (page.nextAfter && rows.size < wanted) {
    if (cursors.has(page.nextAfter)) throw new Error("Session inventory returned a repeated cursor")
    cursors.add(page.nextAfter)
    page = await server.sessions.inventory({ ...input, after: page.nextAfter })
    for (const row of page.rows) rows.set(row.ref.sessionId, row)
    for (const [id, status] of page.statuses) statuses.set(id, status)
    degraded ||= page.degraded === true
  }
  return { ...page, rows: [...rows.values()], statuses, degraded }
}
