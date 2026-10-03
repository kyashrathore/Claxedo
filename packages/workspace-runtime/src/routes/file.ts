import { FileContentError, readFileContent, type FileContentRefusal } from "../file-content"
import { Hono } from "hono"
import { WorkspaceTargetError, errorBody } from "@claxedo/session-core"
import { currentSessionCore } from "../session-context"
import type { RelayHostAuthContext } from "@claxedo/session-core/relay-host"
import {
  authorizeWorktreeTarget,
  deniedWorktreeFilter,
  type WorktreeTargetAccessOptions,
  type WorktreeTargetContext,
} from "./worktree-target-access"
import {
  listAllWorkspaceFiles,
  listWorkspaceDirectory,
  resolveWorkspaceFile,
  searchWorkspaceFiles,
  warmWorkspaceSearchIndex,
  workspaceFileStatus,
} from "../workspace-files/file"

type FileRouteContext = {
  req: {
    query: (k: string) => string | undefined
    header: (k: string) => string | undefined
  }
}

function root(c: FileRouteContext) {
  try {
    return currentSessionCore().placement.resolveDirectory(c.req.query("directory") || c.req.header("x-claxedo-directory"))
  } catch (err) {
    if (err instanceof WorkspaceTargetError) return undefined
    throw err
  }
}

function invalidPath() {
  return errorBody("file_invalid_relative_path", "Invalid relative file path")
}

const FILE_REFUSAL_STATUS = { missing: 404, not_a_file: 400, too_large: 413 } as const satisfies Record<FileContentRefusal, number>

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
      try {
        return c.json(await readFileContent(full))
      } catch (error) {
        if (!(error instanceof FileContentError)) throw error
        return c.json(errorBody(`file_${error.refusal}`, error.message), FILE_REFUSAL_STATUS[error.refusal])
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
