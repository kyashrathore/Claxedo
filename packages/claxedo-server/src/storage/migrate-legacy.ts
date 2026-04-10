/**
 * One-time migration from legacy per-workspace pages.db and global tab-context.db
 * into the consolidated claxedo.db.
 *
 * Called lazily on first access. Idempotent — checks for marker rows before migrating.
 */

import Database from "better-sqlite3"
import { existsSync, renameSync } from "fs"
import { homedir } from "os"
import path from "path"
import { Log } from "../log"
import { ClaxedoDB, eq } from "./db"
import {
  ClaxedoPageTable,
  ClaxedoPageStatusTable,
  ClaxedoPageArenaTable,
  ClaxedoPageArenaAgentTable,
  ClaxedoPageArenaWaveTable,
  ClaxedoPageArenaMessageTable,
  ClaxedoPageArenaDeliveryTable,
  ClaxedoTabContextTable,
  ClaxedoTabContextTerminalTable,
  ClaxedoTerminalSessionTable,
} from "./schema"

const log = Log.create({ service: "claxedo-migrate" })

const migratedPages = new Set<string>()
const failedPages = new Set<string>()
let migratedTabContext = false

function rec(input: unknown) {
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined
}

function str(input: unknown) {
  if (typeof input === "string" && input.length > 0) return input
  if (typeof input === "number" && Number.isFinite(input)) return String(input)
  return undefined
}

function int(input: unknown, alt: number) {
  return typeof input === "number" && Number.isFinite(input) ? input : alt
}

function flt(input: unknown, alt: number) {
  return typeof input === "number" && Number.isFinite(input) ? input : alt
}

function iso(input: unknown, alt = new Date().toISOString()) {
  return typeof input === "string" && input.length > 0 ? input : alt
}

export function pagesBaseDir(directory?: string) {
  const dir = directory
  return dir && dir !== "/" ? dir : homedir()
}

function legacyPagesDbPath(directory?: string): string {
  const dir = process.env.CLAXEDO_DATA_DIR || path.join(pagesBaseDir(directory), ".claxedo")
  return path.join(dir, "pages.db")
}

function legacyTabContextDbPath(): string {
  const dir = process.env.CLAXEDO_DATA_DIR || path.join(homedir(), ".claxedo")
  return path.join(dir, "tab-context.db")
}

/**
 * Migrate pages + arena data from a legacy per-workspace pages.db.
 */
export function migratePages(projectId: string, directory?: string) {
  if (migratedPages.has(projectId) || failedPages.has(projectId)) return

  const legacyPath = legacyPagesDbPath(directory)
  if (!existsSync(legacyPath)) {
    migratedPages.add(projectId)
    return
  }

  const existing = ClaxedoDB.use((db) =>
    db
      .select({ id: ClaxedoPageTable.id })
      .from(ClaxedoPageTable)
      .where(eq(ClaxedoPageTable.project_id, projectId))
      .limit(1)
      .all(),
  )
  if (existing.length > 0) {
    migratedPages.add(projectId)
    return
  }

  log.info("migrating legacy pages.db", { projectId, path: legacyPath })

  try {
    const legacy = new Database(legacyPath, { readonly: true })

    ClaxedoDB.transaction((db) => {
      const pages = legacy.prepare("SELECT * FROM pages").all() as unknown[]
      for (const page of pages) {
        const row = rec(page)
        const id = str(row?.id)
        if (!row || !id) continue
        db.insert(ClaxedoPageTable)
          .values({
            id,
            project_id: projectId,
            title: str(row.title) ?? "Untitled",
            content: str(row.content) ?? "",
            status: str(row.status) ?? "draft",
            session_id: str(row.session_id) ?? null,
            created_at: iso(row.created_at),
            updated_at: iso(row.updated_at),
          })
          .onConflictDoNothing()
          .run()
      }

      const hasStatuses = legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='page_statuses'").get()
      if (hasStatuses) {
        const statuses = legacy.prepare("SELECT * FROM page_statuses").all() as unknown[]
        for (const s of statuses) {
          const row = rec(s)
          const id = str(row?.id)
          const name = str(row?.name)
          if (!row || !id || !name) continue
          db.insert(ClaxedoPageStatusTable)
            .values({
              id,
              project_id: projectId,
              name,
              color: str(row.color) ?? "#6b7280",
              position: int(row.position, 0),
              transitions: str(row.transitions) ?? "[]",
            })
            .onConflictDoNothing()
            .run()
        }
      }

      const hasArena = legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='page_arena'").get()
      if (hasArena) {
        const arenas = legacy.prepare("SELECT * FROM page_arena").all() as unknown[]
        for (const a of arenas) {
          const row = rec(a)
          const id = str(row?.id)
          const page_id = str(row?.page_id)
          if (!row || !id || !page_id) continue
          db.insert(ClaxedoPageArenaTable)
            .values({
              id,
              page_id,
              directory: str(row.directory) ?? "",
              parent_session_id: str(row.parent_session_id) ?? "",
              status: str(row.status) ?? "idle",
              config_json: str(row.config_json) ?? "{}",
              synopsis: str(row.synopsis) ?? "",
              active_wave_id: str(row.active_wave_id) ?? "",
              current_round: int(row.current_round, 0),
              stop_reason: str(row.stop_reason) ?? "",
              last_error: str(row.last_error) ?? "",
              created_at: int(row.created_at, Date.now()),
              updated_at: int(row.updated_at, Date.now()),
            })
            .onConflictDoNothing()
            .run()
        }

        const agents = legacy.prepare("SELECT * FROM page_arena_agent").all() as unknown[]
        for (const a of agents) {
          const row = rec(a)
          const id = str(row?.id)
          const arena_id = str(row?.arena_id)
          const agent_key = str(row?.agent_key)
          const display_name = str(row?.display_name)
          if (!row || !id || !arena_id || !agent_key || !display_name) continue
          db.insert(ClaxedoPageArenaAgentTable)
            .values({
              id,
              arena_id,
              agent_key,
              display_name,
              role: str(row.role) ?? "",
              duty: str(row.duty) ?? "",
              model: str(row.model) ?? "",
              style: str(row.style) ?? "",
              temperature: flt(row.temperature, 0),
              session_id: str(row.session_id) ?? "",
              status: str(row.status) ?? "idle",
              settled: int(row.settled, 0),
              last_signal: str(row.last_signal) ?? "",
              created_at: int(row.created_at, Date.now()),
              updated_at: int(row.updated_at, Date.now()),
            })
            .onConflictDoNothing()
            .run()
        }

        const waves = legacy.prepare("SELECT * FROM page_arena_wave").all() as unknown[]
        for (const w of waves) {
          const row = rec(w)
          const id = str(row?.id)
          const arena_id = str(row?.arena_id)
          if (!row || !id || !arena_id) continue
          db.insert(ClaxedoPageArenaWaveTable)
            .values({
              id,
              arena_id,
              status: str(row.status) ?? "running",
              round_num: int(row.round_num, 0),
              target_json: str(row.target_json) ?? "[]",
              termination: str(row.termination) ?? "",
              started_at: int(row.started_at, Date.now()),
              finished_at: int(row.finished_at, 0),
              updated_at: int(row.updated_at, Date.now()),
            })
            .onConflictDoNothing()
            .run()
        }

        const messages = legacy.prepare("SELECT * FROM page_arena_message").all() as unknown[]
        for (const m of messages) {
          const row = rec(m)
          const id = str(row?.id)
          const arena_id = str(row?.arena_id)
          const wave_id = str(row?.wave_id)
          const kind = str(row?.kind)
          if (!row || !id || !arena_id || !wave_id || !kind) continue
          db.insert(ClaxedoPageArenaMessageTable)
            .values({
              id,
              arena_id,
              wave_id,
              round_num: int(row.round_num, 0),
              kind,
              source_agent_key: str(row.source_agent_key) ?? "",
              text: str(row.text) ?? "",
              raw_text: str(row.raw_text) ?? "",
              control_signal: str(row.control_signal) ?? "continue",
              metadata_json: str(row.metadata_json) ?? "{}",
              created_at: int(row.created_at, Date.now()),
            })
            .onConflictDoNothing()
            .run()
        }

        const hasDelivery = legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='page_arena_delivery'").get()
        if (hasDelivery) {
          const deliveries = legacy.prepare("SELECT * FROM page_arena_delivery").all() as unknown[]
          for (const d of deliveries) {
            const row = rec(d)
            const id = str(row?.id)
            const arena_id = str(row?.arena_id)
            const wave_id = str(row?.wave_id)
            const message_id = str(row?.message_id)
            const source_agent_key = str(row?.source_agent_key)
            const target_agent_key = str(row?.target_agent_key)
            if (!row || !id || !arena_id || !wave_id || !message_id || !source_agent_key || !target_agent_key) continue
            db.insert(ClaxedoPageArenaDeliveryTable)
              .values({
                id,
                arena_id,
                wave_id,
                message_id,
                source_agent_key,
                target_agent_key,
                status: str(row.status) ?? "done",
                attempt: int(row.attempt, 1),
                error: str(row.error) ?? "",
                created_at: int(row.created_at, Date.now()),
                updated_at: int(row.updated_at, Date.now()),
              })
              .onConflictDoNothing()
              .run()
          }
        }
      }
    })

    legacy.close()

    try {
      renameSync(legacyPath, legacyPath + ".migrated")
    } catch {
      // Ignore rename errors (e.g. permissions)
    }

    log.info("legacy pages.db migration complete", { projectId, pages: "done" })
    migratedPages.add(projectId)
  } catch (err) {
    log.error("legacy pages.db migration failed", {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    })
    failedPages.add(projectId)
  }
}

/**
 * Migrate tab context data from legacy global tab-context.db.
 */
export function migrateTabContext() {
  if (migratedTabContext) return

  const legacyPath = legacyTabContextDbPath()
  if (!existsSync(legacyPath)) {
    migratedTabContext = true
    return
  }

  const existing = ClaxedoDB.use((db) =>
    db.select({ tab_id: ClaxedoTabContextTable.tab_id }).from(ClaxedoTabContextTable).limit(1).all(),
  )
  if (existing.length > 0) {
    migratedTabContext = true
    return
  }

  log.info("migrating legacy tab-context.db", { path: legacyPath })

  try {
    const legacy = new Database(legacyPath, { readonly: true })

    ClaxedoDB.transaction((db) => {
      const contexts = legacy.prepare("SELECT * FROM tab_context").all() as unknown[]
      for (const row of contexts) {
        const item = rec(row)
        const tab_id = str(item?.tab_id)
        const payload = str(item?.payload)
        if (!item || !tab_id || !payload) continue
        db.insert(ClaxedoTabContextTable)
          .values({
            tab_id,
            payload,
            updated_at: int(item.updated_at, Date.now()),
          })
          .onConflictDoNothing()
          .run()
      }

      const hasTerminal = legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tab_context_terminal'").get()
      if (hasTerminal) {
        const terminals = legacy.prepare("SELECT * FROM tab_context_terminal").all() as unknown[]
        for (const row of terminals) {
          const item = rec(row)
          const terminal_id = str(item?.terminal_id)
          const tab_id = str(item?.tab_id)
          if (!item || !terminal_id || !tab_id) continue
          db.insert(ClaxedoTabContextTerminalTable)
            .values({
              terminal_id,
              tab_id,
              updated_at: int(item.updated_at, Date.now()),
            })
            .onConflictDoNothing()
            .run()
        }
      }

      const hasSession = legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='terminal_session'").get()
      if (hasSession) {
        const sessions = legacy.prepare("SELECT * FROM terminal_session").all() as unknown[]
        for (const row of sessions) {
          const item = rec(row)
          const terminal_id = str(item?.terminal_id)
          if (!item || !terminal_id) continue
          db.insert(ClaxedoTerminalSessionTable)
            .values({
              terminal_id,
              tab_id: str(item.tab_id) ?? null,
              workspace_id: str(item.workspace_id) ?? null,
              provider: str(item.provider) ?? null,
              session_id: str(item.session_id) ?? null,
              transcript_path: str(item.transcript_path) ?? null,
              ref_name: str(item.ref_name) ?? null,
              prompt: str(item.prompt) ?? null,
              last_assistant_message: str(item.last_assistant_message) ?? null,
              event_type: str(item.event_type) ?? null,
              updated_at: int(item.updated_at, Date.now()),
            })
            .onConflictDoNothing()
            .run()
        }
      }
    })

    legacy.close()

    try {
      renameSync(legacyPath, legacyPath + ".migrated")
    } catch {
      // Ignore rename errors
    }

    log.info("legacy tab-context.db migration complete")
    migratedTabContext = true
  } catch (err) {
    log.error("legacy tab-context.db migration failed", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
