import fs from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { REPO_ROOT } from "./node-loader"

type Fetch = (request: Request, ...rest: any[]) => Response | Promise<Response>
const { getMimeType } = createRequire(path.join(REPO_ROOT, "packages/claxedo-local-server/package.json"))("hono/utils/mime") as {
  getMimeType(path: string): string | undefined
}

export async function appBundleFile(directory: string, pathname: string, acceptsHtml: boolean): Promise<Response | undefined> {
  const root = path.resolve(directory)
  const file = path.resolve(root, `.${decodeURIComponent(pathname)}`)
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) return undefined
  const served = path.extname(file) ? file : acceptsHtml ? path.join(root, "index.html") : undefined
  if (!served) return undefined
  try {
    return new Response(await fs.readFile(served), { headers: { "content-type": getMimeType(served) ?? "application/octet-stream", "cache-control": "no-store" } })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

export function withAppBundle(fetch: Fetch, directory: string): Fetch {
  return async (request, ...args) => {
    const reply = await fetch(request, ...args)
    const { pathname } = new URL(request.url)
    if (reply.status !== 404 || request.method !== "GET" || /^\/api(\/|$)/.test(pathname)) return reply
    return await appBundleFile(directory, pathname, request.headers.get("accept")?.includes("text/html") ?? false) ?? reply
  }
}
