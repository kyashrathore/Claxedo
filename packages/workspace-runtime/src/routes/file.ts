import { Hono } from "hono"
import { assertTarget, WorkspaceTargetError } from "../target"
import type { RelayHostAuthContext } from "../workspace-host-service-auth"
import { errorBody, webStreamFrom } from "./http"
import {
  authorizeWorktreeTarget,
  deniedWorktreeFilter,
  type WorktreeTargetAccessOptions,
  type WorktreeTargetContext,
} from "./worktree-target-access"
import {
  listAllWorkspaceFiles,
  listWorkspaceDirectory,
  readWorkspaceFileContent,
  resolveWorkspaceFile,
  searchWorkspaceFiles,
  warmWorkspaceSearchIndex,
  workspaceFileContentType,
  workspaceFileStatus,
  workspaceRawFile,
} from "../workspace-files/file"

type FileRouteContext = {
  req: {
    query: (k: string) => string | undefined
    header: (k: string) => string | undefined
  }
}

function root(c: FileRouteContext) {
  try {
    return assertTarget(c.req.query("directory") || c.req.header("x-claxedo-directory"))
  } catch (err) {
    if (err instanceof WorkspaceTargetError) return undefined
    throw err
  }
}

function invalidPath() {
  return errorBody("file_invalid_relative_path", "Invalid relative file path")
}

function invalidDirectory() {
  return errorBody("file_invalid_directory", "File directory must match configured workspace")
}

async function routeFile(root: string, input?: string) {
  try {
    return await resolveWorkspaceFile(root, input)
  } catch (err) {
    if (err instanceof WorkspaceTargetError) return undefined
    throw err
  }
}

export function FileRoutes(options: WorktreeTargetAccessOptions = {}) {
  /**
   * The root every handler reads under, or the refusal it answers with: the
   * directory has to be this runtime's, and it and the path asked for have to
   * belong to a session this caller may read. `path` names a directory on the
   * listing routes, so what is under it counts as asked for too.
   */
  const readable = async (c: WorktreeTargetContext): Promise<string | Response> => {
    const base = root(c)
    if (!base) return c.json(invalidDirectory(), 400)
    return await authorizeWorktreeTarget(c, options, {
      operation: "worktree_read",
      directory: base,
      paths: [c.req.query("path")],
    }) ?? base
  }

  return new Hono<{ Variables: RelayHostAuthContext }>()
    .get("/find/file", async (c) => {
      const base = await readable(c)
      if (typeof base !== "string") return base
      const query = c.req.query("query") ?? ""
      const type = c.req.query("type") === "directory" ? "directory" : c.req.query("dirs") === "false" ? "file" : "any"
      const limit = Math.min(Number(c.req.query("limit") ?? "50") || 50, 200)
      // `ls-files` and the walk behind the index both name their entries from
      // this directory, so no repository lookup is involved and a directory
      // outside Git still searches.
      const visible = await deniedWorktreeFilter(c, options, { directory: base, bases: ["directory"] })
      // Refused entries are dropped after the match, not before: the index is
      // shared by every caller of this root and must not be cut to one of them.
      return c.json((await searchWorkspaceFiles(base, query, type, limit)).filter((item) => visible(item)))
    })
    .get("/file", async (c) => {
      const base = await readable(c)
      if (typeof base !== "string") return base
      const dir = await routeFile(base, c.req.query("path"))
      if (!dir) return c.json(invalidPath(), 400)
      // The tree lists a directory when the panel opens, seconds before the
      // first keystroke reaches /find/file — build the index off that path so
      // the search itself never pays for the listing.
      warmWorkspaceSearchIndex(base)
      const visible = await deniedWorktreeFilter(c, options, { directory: base, bases: ["directory"] })
      try {
        return c.json((await listWorkspaceDirectory(base, dir)).filter((entry) => visible(entry.path)))
      } catch {
        return c.json([])
      }
    })
    .get("/file/content", async (c) => {
      const base = await readable(c)
      if (typeof base !== "string") return base
      const full = await routeFile(base, c.req.query("path"))
      if (!full) return c.json(invalidPath(), 400)
      return c.json(await readWorkspaceFileContent(full))
    })
    .get("/file/raw", async (c) => {
      const base = await readable(c)
      if (typeof base !== "string") return base
      const full = await routeFile(base, c.req.query("path"))
      if (!full) return c.json(invalidPath(), 400)

      try {
        const raw = await workspaceRawFile(full)
        if (!raw) return c.json(errorBody("file_not_found", "File not found"), 404)
        return new Response(webStreamFrom(raw.stream), {
          headers: {
            "content-length": String(raw.size),
            "content-type": workspaceFileContentType(full),
            // The workspace serves its own pages from this origin, and an SVG is a
            // document that can carry script. `nosniff` holds the browser to the type
            // above, and the sandbox denies whatever a document among these bytes
            // would otherwise run as this origin.
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
          },
        })
      } catch {
        return c.json(errorBody("file_not_found", "File not found"), 404)
      }
    })
    .get("/file/status", async (c) => {
      const base = await readable(c)
      if (typeof base !== "string") return base
      // Mixed: the tracked arm is `diff --numstat HEAD`, named from the
      // repository and covering all of it; the untracked arm is `ls-files`,
      // named from this directory.
      const visible = await deniedWorktreeFilter(c, options, { directory: base, bases: ["directory", "repository"] })
      return c.json((await workspaceFileStatus(base)).filter((entry) => visible(entry.path)))
    })
    .get("/file/all", async (c) => {
      const base = await readable(c)
      if (typeof base !== "string") return base
      const visible = await deniedWorktreeFilter(c, options, { directory: base, bases: ["directory"] })
      return c.json({ paths: (await listAllWorkspaceFiles(base)).filter((item) => visible(item)) })
    })
}
