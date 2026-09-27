import fs from "node:fs/promises"
import { createServer, type Server } from "node:http"
import path from "node:path"
import { git, gitFolder } from "./git"
import { listenOnLoopback } from "./ports"

export type GitRemote = { url: string; source: string; close(): Promise<void> }

function serveFiles(served: string): Server {
  return createServer((request, response) => {
    const requested = decodeURIComponent(new URL(request.url ?? "/", "http://remote").pathname)
    const file = path.join(served, path.normalize(requested))
    if (!file.startsWith(served + path.sep)) return void response.writeHead(404).end()
    fs.readFile(file).then(
      (body) => response.writeHead(200).end(body),
      (error: NodeJS.ErrnoException) => response.writeHead(error.code === "ENOENT" ? 404 : 500).end(error.code ?? ""),
    )
  })
}

export async function serveGitRemote(input: { root: string; name: string; port: number }): Promise<GitRemote> {
  const source = await gitFolder(input.root, `${input.name}-source`)
  const served = path.join(input.root, "served")
  const bare = path.join(served, `${input.name}.git`)
  await git(input.root, "clone", "-q", "--bare", source, bare)
  await git(bare, "update-server-info")
  const server = serveFiles(served)
  await listenOnLoopback(server, input.port)
  return {
    url: `http://127.0.0.1:${input.port}/${input.name}.git`,
    source,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
