import { Hono } from "hono"
import fs from "fs"
import path from "path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { assertTarget } from "../target"

const execFileAsync = promisify(execFile)

function root(c: {
  req: {
    query: (k: string) => string | undefined
    header: (k: string) => string | undefined
  }
}) {
  return assertTarget(c.req.query("directory") || c.req.header("x-opencode-directory"))
}

function file(root: string, input?: string) {
  const txt = input?.trim()
  if (!txt) return root
  return path.isAbsolute(txt) ? path.resolve(txt) : path.resolve(root, txt)
}

async function globSearch(
  searchDir: string,
  query: string,
  type: "file" | "directory" | "any",
  limit: number,
) {
  const out: string[] = []
  const q = query.trim().toLowerCase()
  const queue = [""]
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
  return out
}

async function gitCmd(root: string, args: string[]) {
  const { stdout } = await execFileAsync("git", ["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", ...args], { cwd: root })
  return stdout
}

async function status(root: string) {
  try {
    const diff = await gitCmd(root, ["diff", "--numstat", "HEAD"])
    const changed = diff
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [added, removed, path] = line.split("\t")
        return {
          path,
          added: added === "-" ? 0 : parseInt(added ?? "0", 10),
          removed: removed === "-" ? 0 : parseInt(removed ?? "0", 10),
          status: "modified" as const,
        }
      })

    const extra = await gitCmd(root, ["ls-files", "--others", "--exclude-standard"])
    const added = await Promise.all(
      extra
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(async (item) => {
          try {
            const text = await fs.promises.readFile(path.join(root, item), "utf-8")
            return {
              path: item,
              added: text.split("\n").length,
              removed: 0,
              status: "added" as const,
            }
          } catch {
            return
          }
        }),
    )

    const removed = await gitCmd(root, ["diff", "--name-only", "--diff-filter=D", "HEAD"])
    return [
      ...changed,
      ...added.filter((item): item is Exclude<typeof item, undefined> => !!item),
      ...removed
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((item) => ({
          path: item,
          added: 0,
          removed: 0,
          status: "deleted" as const,
        })),
    ]
  } catch {
    return []
  }
}

export function FileRoutes() {
  return new Hono()
    .get("/find/file", async (c) => {
      const query = c.req.query("query") ?? ""
      const type = c.req.query("type") === "directory" ? "directory" : c.req.query("dirs") === "false" ? "file" : "any"
      const limit = Math.min(Number(c.req.query("limit") ?? "50") || 50, 200)
      return c.json(await globSearch(root(c), query, type, limit))
    })
    .get("/file", async (c) => {
      const base = root(c)
      const dir = file(base, c.req.query("path"))
      const exclude = new Set([".git", ".DS_Store"])
      try {
        const rows = await fs.promises.readdir(dir, { withFileTypes: true })
        return c.json(
          rows
            .filter((item) => !exclude.has(item.name))
            .map((item) => ({
              name: item.name,
              path: path.relative(base, path.join(dir, item.name)),
              absolute: path.join(dir, item.name),
              type: item.isDirectory() ? "directory" : "file",
              ignored: item.name.startsWith(".") || item.name === "node_modules",
            }))
            .sort((a, b) => {
              if (a.type !== b.type) return a.type === "directory" ? -1 : 1
              return a.name.localeCompare(b.name)
            }),
        )
      } catch {
        return c.json([])
      }
    })
    .get("/file/content", async (c) => {
      const full = file(root(c), c.req.query("path"))
      try {
        const buf = await fs.promises.readFile(full)
        try {
          return c.json({
            type: "text",
            content: new TextDecoder("utf-8", { fatal: true }).decode(buf).trim(),
          })
        } catch {
          return c.json({
            type: "binary",
            content: "",
          })
        }
      } catch {
        return c.json({
          type: "text",
          content: "",
        })
      }
    })
    .get("/file/status", async (c) => c.json(await status(root(c))))
}
