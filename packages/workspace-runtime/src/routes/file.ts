import { Hono } from "hono"
import { Readable } from "node:stream"
import { assertTarget, WorkspaceTargetError } from "../target"
import { errorBody } from "./http"
import {
  listAllWorkspaceFiles,
  listWorkspaceDirectory,
  readWorkspaceFileContent,
  resolveWorkspaceFile,
  searchWorkspaceFiles,
  workspaceFileStatus,
  workspaceRawFile,
} from "../workspace-files/file"

type FileRouteContext = {
  req: {
    query: (k: string) => string | undefined
    header: (k: string) => string | undefined
  }
}

type Options = {
  resolveRoot?: (c: FileRouteContext) => string | Promise<string>
}

async function root(c: FileRouteContext, options: Options) {
  try {
    if (options.resolveRoot) return await options.resolveRoot(c)
    return assertTarget(c.req.query("directory") || c.req.header("x-opencode-directory"))
  } catch (err) {
    if (err instanceof WorkspaceTargetError) return
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
    if (err instanceof WorkspaceTargetError) return
    throw err
  }
}

export function FileRoutes(options: Options = {}) {
  return new Hono()
    .get("/find/file", async (c) => {
      const base = await root(c, options)
      if (!base) return c.json(invalidDirectory(), 400)
      const query = c.req.query("query") ?? ""
      const type = c.req.query("type") === "directory" ? "directory" : c.req.query("dirs") === "false" ? "file" : "any"
      const limit = Math.min(Number(c.req.query("limit") ?? "50") || 50, 200)
      return c.json(await searchWorkspaceFiles(base, query, type, limit))
    })
    .get("/file", async (c) => {
      const base = await root(c, options)
      if (!base) return c.json(invalidDirectory(), 400)
      const dir = await routeFile(base, c.req.query("path"))
      if (!dir) return c.json(invalidPath(), 400)
      try {
        return c.json(await listWorkspaceDirectory(base, dir))
      } catch {
        return c.json([])
      }
    })
    .get("/file/content", async (c) => {
      const base = await root(c, options)
      if (!base) return c.json(invalidDirectory(), 400)
      const full = await routeFile(base, c.req.query("path"))
      if (!full) return c.json(invalidPath(), 400)
      return c.json(await readWorkspaceFileContent(full))
    })
    .get("/file/raw", async (c) => {
      const base = await root(c, options)
      if (!base) return c.json(invalidDirectory(), 400)
      const full = await routeFile(base, c.req.query("path"))
      if (!full) return c.json(invalidPath(), 400)

      try {
        const raw = await workspaceRawFile(full)
        if (!raw) return c.json(errorBody("file_not_found", "File not found"), 404)
        return new Response(Readable.toWeb(raw.stream) as unknown as ReadableStream<Uint8Array>, {
          headers: {
            "content-length": String(raw.size),
            "content-type": "application/octet-stream",
          },
        })
      } catch {
        return c.json(errorBody("file_not_found", "File not found"), 404)
      }
    })
    .get("/file/status", async (c) => {
      const base = await root(c, options)
      if (!base) return c.json(invalidDirectory(), 400)
      return c.json(await workspaceFileStatus(base))
    })
    .get("/file/all", async (c) => {
      const base = await root(c, options)
      if (!base) return c.json(invalidDirectory(), 400)
      return c.json({ paths: await listAllWorkspaceFiles(base) })
    })
}
