/**
 * OpenCode-compat routes (workspace-runtime level)
 *
 * Only the routes that require local filesystem access on the workspace machine.
 * Global routes (provider, config, project, experimental/session) are served by
 * claxedo-server's opencode-compat layer and proxy'd here only for cat-2 paths.
 *
 * Routes:
 *   GET  /path        — OS paths (home, config, worktree)
 */

import { Hono } from "hono"
import * as os from "os"
import * as path from "path"

const CLAXEDO_DIR = path.join(os.homedir(), ".claxedo")

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

}
