/**
 * OpenCode-compat routes (workspace-runtime level)
 *
 * Only the routes that require local filesystem access on the workspace machine.
 * Global routes (provider, config, project, experimental/session) are served by
 * claxedo-server's opencode-compat layer and proxy'd here only for cat-2 paths.
 *
 * Routes:
 *   GET  /path        — OS paths (home, config, worktree)
 *   GET  /find/file   — real filesystem glob search
 *   GET  /file        — real directory listing
 */

import { Hono } from "hono"
import * as os from "os"
import * as path from "path"
import * as fs from "fs"
import { Log } from "../log"

const log = Log.create({ service: "opencode-compat" })

const CLAXEDO_DIR = path.join(os.homedir(), ".claxedo")

// ── File search ───────────────────────────────────────────────────────────────

async function globSearch(
  searchDir: string,
  query: string,
  type: "file" | "directory" | "any",
  limit: number,
): Promise<string[]> {
  const out: string[] = []
  const q = query.trim().toLowerCase()
  const queue = [""]
  try {
    while (queue.length && out.length < limit) {
      const rel = queue.shift()!
      const abs = rel ? path.join(searchDir, rel) : searchDir
      let rows: fs.Dirent[]
      try {
        rows = (await fs.promises.readdir(abs, { withFileTypes: true })).toSorted((a, b) => a.name.localeCompare(b.name))
      } catch {
        continue
      }
      for (const row of rows) {
        if (row.name === ".git" || row.name === ".DS_Store") continue
        const next = rel ? path.join(rel, row.name) : row.name
        const hit = !q || next.toLowerCase().includes(q)
        if (row.isDirectory()) {
          queue.push(next)
          if (type !== "file" && hit) out.push(next)
        }
        if (!row.isDirectory() && type !== "directory" && hit) out.push(next)
        if (out.length >= limit) break
      }
    }
  } catch (err) {
    log.warn("globSearch error", { searchDir, query, err })
  }
  return out
}

// ── Routes ────────────────────────────────────────────────────────────────────

export function OpenCodeCompatRoutes() {
  return new Hono()

    // ── Path ──────────────────────────────────────────────────────────────────

    .get("/path", (c) => {
      const directory = c.req.query("directory") || process.cwd()
      return c.json({
        home: os.homedir(),
        state: CLAXEDO_DIR,
        config: CLAXEDO_DIR,
        worktree: directory,
        directory,
      })
    })

    // ── File search ───────────────────────────────────────────────────────────

    .get("/find/file", async (c) => {
      const query = c.req.query("query") ?? ""
      const type = c.req.query("type") === "directory" ? "directory" : c.req.query("dirs") === "false" ? "file" : "any"
      const limit = Math.min(Number(c.req.query("limit") ?? "50") || 50, 200)
      const searchDir = c.req.query("directory") || c.req.header("x-opencode-directory") || process.cwd()
      const results = await globSearch(searchDir, query, type, limit)
      return c.json(results)
    })

    // ── Directory listing ─────────────────────────────────────────────────────

    .get("/file", async (c) => {
      const dirPath = c.req.query("path") || c.req.header("x-opencode-directory") || process.cwd()
      const exclude = new Set([".git", ".DS_Store"])
      try {
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
        const nodes = entries
          .filter((e) => !exclude.has(e.name))
          .map((e) => ({
            name: e.name,
            path: e.name,
            absolute: path.join(dirPath, e.name),
            type: e.isDirectory() ? "directory" : "file",
            ignored: e.name.startsWith(".") || e.name === "node_modules",
          }))
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === "directory" ? -1 : 1
            return a.name.localeCompare(b.name)
          })
        return c.json(nodes)
      } catch {
        return c.json([])
      }
    })
}
