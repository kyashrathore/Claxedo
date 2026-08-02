/**
 * OpenCode-compat routes (workspace-runtime level)
 *
 * Only the routes that require local filesystem access on the workspace machine.
 * Global routes (provider, config, project, experimental/session) are served by
 * the embedding product and proxy here only for cat-2 paths.
 *
 * Routes:
 *   GET  /path        — OS paths (home, config, worktree)
 */

import { Hono } from "hono"
import * as os from "os"
import { assertTarget, WorkspaceTargetError } from "../target"
import { errorBody } from "./http"
import { workspaceRuntimeDataDir } from "../env"

// ── Routes ────────────────────────────────────────────────────────────────────

export function OpenCodeCompatRoutes() {
  return new Hono()

    // ── Path ──────────────────────────────────────────────────────────────────

    .get("/path", (c) => {
      let directory: string
      try {
        directory = assertTarget(c.req.query("directory") || c.req.header("x-opencode-directory"))
      } catch (err) {
        if (err instanceof WorkspaceTargetError) {
          return c.json(errorBody("path_invalid_directory", "Path directory must match configured workspace"), 400)
        }
        throw err
      }
      return c.json({
        home: os.homedir(),
        state: workspaceRuntimeDataDir(),
        config: workspaceRuntimeDataDir(),
        worktree: directory,
        directory,
      })
    })

}
