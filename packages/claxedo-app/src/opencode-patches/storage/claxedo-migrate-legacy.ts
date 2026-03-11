/**
 * One-time migration from legacy per-workspace pages.db and global tab-context.db
 * into the consolidated claxedo.db.
 *
 * Called lazily on first access. Idempotent — checks for marker rows before migrating.
 */

import { Database as BunDatabase } from "bun:sqlite"
import { existsSync, renameSync } from "fs"
import { homedir } from "os"
import path from "path"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { ClaxedoDB, eq } from "./claxedo-db"
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
} from "./claxedo/schema"

const log = Log.create({ service: "claxedo-migrate" })

const migratedPages = new Set<string>()
const failedPages = new Set<string>()
let migratedTabContext = false

export function pagesBaseDir() {
  const dir = Instance.directory
  return dir && dir !== "/" ? dir : homedir()
}

function legacyPagesDbPath(): string {
  const dataDir = process.env.CLAXEDO_DATA_DIR || path.join(pagesBaseDir(), ".claxedo")
  return path.join(dataDir, "pages.db")
}

function legacyTabContextDbPath(): string {
  const dataDir = process.env.CLAXEDO_DATA_DIR || path.join(homedir(), ".claxedo")
  return path.join(dataDir, "tab-context.db")
}

/**
 * Migrate pages + arena data from a legacy per-workspace pages.db.
 * Should be called within an Instance context so project_id is available.
 */
export function migratePages(projectId: string) {
  if (migratedPages.has(projectId) || failedPages.has(projectId)) return

  const legacyPath = legacyPagesDbPath()
  if (!existsSync(legacyPath)) {
    migratedPages.add(projectId)
    return
  }

  // Check if we already migrated pages for this project
  const existing = ClaxedoDB.use((db) =>
    db
      .select({ id: ClaxedoPageTable.id })
      .from(ClaxedoPageTable)
      .where(
        eq(ClaxedoPageTable.project_id, projectId),
      )
      .limit(1)
      .all(),
  )
  if (existing.length > 0) {
    migratedPages.add(projectId)
    return
  }

  log.info("migrating legacy pages.db", { projectId, path: legacyPath })

  try {
    const legacy = new BunDatabase(legacyPath, { readonly: true })

    ClaxedoDB.transaction((db) => {
      // Migrate pages
      const pages = legacy.query("SELECT * FROM pages").all() as Array<Record<string, any>>
      for (const page of pages) {
        db.insert(ClaxedoPageTable)
          .values({
            id: page.id,
            project_id: projectId,
            title: page.title || "Untitled",
            content: page.content || "",
            status: page.status || "draft",
            session_id: page.session_id || null,
            created_at: page.created_at || new Date().toISOString(),
            updated_at: page.updated_at || new Date().toISOString(),
          })
          .onConflictDoNothing()
          .run()
      }

      // Migrate page_statuses
      const hasStatuses = legacy.query("SELECT name FROM sqlite_master WHERE type='table' AND name='page_statuses'").get()
      if (hasStatuses) {
        const statuses = legacy.query("SELECT * FROM page_statuses").all() as Array<Record<string, any>>
        for (const s of statuses) {
          db.insert(ClaxedoPageStatusTable)
            .values({
              id: s.id,
              project_id: projectId,
              name: s.name,
              color: s.color || "#6b7280",
              position: s.position ?? 0,
              transitions: s.transitions || "[]",
            })
            .onConflictDoNothing()
            .run()
        }
      }

      // Migrate arena tables
      const hasArena = legacy.query("SELECT name FROM sqlite_master WHERE type='table' AND name='page_arena'").get()
      if (hasArena) {
        const arenas = legacy.query("SELECT * FROM page_arena").all() as Array<Record<string, any>>
        for (const a of arenas) {
          db.insert(ClaxedoPageArenaTable)
            .values({
              id: a.id,
              page_id: a.page_id,
              directory: a.directory || "",
              parent_session_id: a.parent_session_id || "",
              status: a.status || "idle",
              config_json: a.config_json || "{}",
              synopsis: a.synopsis || "",
              active_wave_id: a.active_wave_id || "",
              current_round: a.current_round ?? 0,
              stop_reason: a.stop_reason || "",
              last_error: a.last_error || "",
              created_at: a.created_at ?? Date.now(),
              updated_at: a.updated_at ?? Date.now(),
            })
            .onConflictDoNothing()
            .run()
        }

        const agents = legacy.query("SELECT * FROM page_arena_agent").all() as Array<Record<string, any>>
        for (const a of agents) {
          db.insert(ClaxedoPageArenaAgentTable)
            .values({
              id: a.id,
              arena_id: a.arena_id,
              agent_key: a.agent_key,
              display_name: a.display_name,
              role: a.role || "",
              duty: a.duty || "",
              model: a.model || "",
              style: a.style || "",
              temperature: a.temperature ?? 0,
              session_id: a.session_id || "",
              status: a.status || "idle",
              settled: a.settled ?? 0,
              last_signal: a.last_signal || "",
              created_at: a.created_at ?? Date.now(),
              updated_at: a.updated_at ?? Date.now(),
            })
            .onConflictDoNothing()
            .run()
        }

        const waves = legacy.query("SELECT * FROM page_arena_wave").all() as Array<Record<string, any>>
        for (const w of waves) {
          db.insert(ClaxedoPageArenaWaveTable)
            .values({
              id: w.id,
              arena_id: w.arena_id,
              status: w.status || "running",
              round_num: w.round_num ?? 0,
              target_json: w.target_json || "[]",
              termination: w.termination || "",
              started_at: w.started_at ?? Date.now(),
              finished_at: w.finished_at ?? 0,
              updated_at: w.updated_at ?? Date.now(),
            })
            .onConflictDoNothing()
            .run()
        }

        const messages = legacy.query("SELECT * FROM page_arena_message").all() as Array<Record<string, any>>
        for (const m of messages) {
          db.insert(ClaxedoPageArenaMessageTable)
            .values({
              id: m.id,
              arena_id: m.arena_id,
              wave_id: m.wave_id,
              round_num: m.round_num ?? 0,
              kind: m.kind,
              source_agent_key: m.source_agent_key || "",
              text: m.text || "",
              raw_text: m.raw_text || "",
              control_signal: m.control_signal || "continue",
              metadata_json: m.metadata_json || "{}",
              created_at: m.created_at ?? Date.now(),
            })
            .onConflictDoNothing()
            .run()
        }

        const hasDelivery = legacy.query("SELECT name FROM sqlite_master WHERE type='table' AND name='page_arena_delivery'").get()
        if (hasDelivery) {
          const deliveries = legacy.query("SELECT * FROM page_arena_delivery").all() as Array<Record<string, any>>
          for (const d of deliveries) {
            db.insert(ClaxedoPageArenaDeliveryTable)
              .values({
                id: d.id,
                arena_id: d.arena_id,
                wave_id: d.wave_id,
                message_id: d.message_id,
                source_agent_key: d.source_agent_key,
                target_agent_key: d.target_agent_key,
                status: d.status || "done",
                attempt: d.attempt ?? 1,
                error: d.error || "",
                created_at: d.created_at ?? Date.now(),
                updated_at: d.updated_at ?? Date.now(),
              })
              .onConflictDoNothing()
              .run()
          }
        }
      }
    })

    legacy.close()

    // Rename old file as safety net
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

  // Check if we already have data
  const existing = ClaxedoDB.use((db) =>
    db.select({ tab_id: ClaxedoTabContextTable.tab_id }).from(ClaxedoTabContextTable).limit(1).all(),
  )
  if (existing.length > 0) {
    migratedTabContext = true
    return
  }

  log.info("migrating legacy tab-context.db", { path: legacyPath })

  try {
    const legacy = new BunDatabase(legacyPath, { readonly: true })

    ClaxedoDB.transaction((db) => {
      const contexts = legacy.query("SELECT * FROM tab_context").all() as Array<Record<string, any>>
      for (const row of contexts) {
        db.insert(ClaxedoTabContextTable)
          .values({
            tab_id: row.tab_id,
            payload: row.payload,
            updated_at: row.updated_at ?? Date.now(),
          })
          .onConflictDoNothing()
          .run()
      }

      const hasTerminal = legacy.query("SELECT name FROM sqlite_master WHERE type='table' AND name='tab_context_terminal'").get()
      if (hasTerminal) {
        const terminals = legacy.query("SELECT * FROM tab_context_terminal").all() as Array<Record<string, any>>
        for (const row of terminals) {
          db.insert(ClaxedoTabContextTerminalTable)
            .values({
              terminal_id: row.terminal_id,
              tab_id: row.tab_id,
              updated_at: row.updated_at ?? Date.now(),
            })
            .onConflictDoNothing()
            .run()
        }
      }

      const hasSession = legacy.query("SELECT name FROM sqlite_master WHERE type='table' AND name='terminal_session'").get()
      if (hasSession) {
        const sessions = legacy.query("SELECT * FROM terminal_session").all() as Array<Record<string, any>>
        for (const row of sessions) {
          db.insert(ClaxedoTerminalSessionTable)
            .values({
              terminal_id: row.terminal_id,
              tab_id: row.tab_id || null,
              workspace_id: row.workspace_id || null,
              provider: row.provider || null,
              session_id: row.session_id || null,
              transcript_path: row.transcript_path || null,
              ref_name: row.ref_name || null,
              prompt: row.prompt || null,
              last_assistant_message: row.last_assistant_message || null,
              event_type: row.event_type || null,
              updated_at: row.updated_at ?? Date.now(),
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
