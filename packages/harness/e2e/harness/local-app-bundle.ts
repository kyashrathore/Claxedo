import fs from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { REPO_ROOT } from "./node-loader"
import type { LocalServer } from "../../../claxedo-local-server/src/app/start-local-server"

type Fetch = LocalServer["app"]["fetch"]
const { getMimeType } = createRequire(path.join(REPO_ROOT, "packages/claxedo-local-server/package.json"))("hono/utils/mime") as {
  getMimeType(path: string): string | undefined
}

export function withAppBundle(fetch: Fetch, directory: string): Fetch {
  let rootPath: Promise<string> | undefined
  return async (request, ...args) => {
    const reply = await fetch(request, ...args)
    const url = new URL(request.url)
    if (reply.status !== 404 || request.method !== "GET" || url.pathname === "/api" || url.pathname.startsWith("/api/")) return reply
    const root = await (rootPath ??= fs.realpath(directory))
    let pathname: string
    try { pathname = decodeURIComponent(url.pathname) } catch { return reply }
    const file = path.resolve(root, `.${pathname}`)
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) return reply
    try {
      const resolved = await fs.realpath(file)
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return reply
      if ((await fs.stat(resolved)).isFile()) {
        return new Response(await fs.readFile(resolved), {
          headers: { "content-type": getMimeType(resolved) ?? "application/octet-stream", "x-content-type-options": "nosniff", "cache-control": "no-store" },
        })
      }
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error
    }
    if (path.extname(pathname) || !request.headers.get("accept")?.includes("text/html")) return reply
    return new Response(await fs.readFile(path.join(root, "index.html")), {
      headers: { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store" },
    })
  }
}
