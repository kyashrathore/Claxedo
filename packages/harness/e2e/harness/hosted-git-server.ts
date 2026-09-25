import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { git, initRepository } from "./git"

export async function startHostedGitServer(root: string, port: number) {
  const repositories = path.join(root, "git-repositories")
  const working = path.join(root, "git-working")
  const bare = path.join(repositories, "repo.git")
  await fs.mkdir(repositories, { recursive: true })
  await initRepository(working, "Hosted test repository")
  await git(working, "clone", "--bare", "--quiet", working, bare)

  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`)
      const result = spawnSync("git", ["http-backend"], {
        input: Buffer.concat(chunks),
        env: {
          ...process.env,
          GIT_DIR: undefined,
          GIT_INDEX_FILE: undefined,
          GIT_PROJECT_ROOT: repositories,
          GIT_HTTP_EXPORT_ALL: "1",
          REQUEST_METHOD: request.method ?? "GET",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: request.headers["content-type"] ?? "",
          CONTENT_LENGTH: String(Buffer.concat(chunks).length),
          REMOTE_ADDR: "127.0.0.1",
        },
      })
      if (result.error) throw result.error
      if (result.status !== 0) throw new Error(result.stderr.toString())
      const separator = result.stdout.indexOf("\r\n\r\n")
      if (separator < 0) throw new Error("git http-backend returned no headers")
      const headers = result.stdout.subarray(0, separator).toString().split("\r\n")
      let status = 200
      for (const header of headers) {
        const colon = header.indexOf(":")
        if (colon < 0) continue
        const name = header.slice(0, colon).trim()
        const value = header.slice(colon + 1).trim()
        if (name.toLowerCase() === "status") status = Number.parseInt(value, 10)
        else response.setHeader(name, value)
      }
      response.writeHead(status).end(result.stdout.subarray(separator + 4))
    } catch (error) {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", resolve)
  })
  return {
    url: `http://localhost:${port}/repo.git`,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
