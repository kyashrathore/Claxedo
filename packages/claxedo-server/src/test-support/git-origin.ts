import { execFileSync, spawn } from "node:child_process"
import { createServer, type IncomingMessage, type Server } from "node:http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export type GitOrigin = {
  /** A scratch directory beside the repository, removed by `close`. */
  directory: string
  repoUrl: string
  /** Runs git in the origin repository, or in `cwd`, outside any developer config. */
  git: (args: string[], cwd?: string) => string
  /**
   * `reachable: false` answers 503 to every request and `uploads: false` to
   * every object fetch; with `authorization` set, any other header is a 401.
   */
  served: {
    reachable: boolean
    uploads: boolean
    /** Holds every object fetch open, unanswered, while true. */
    stalled?: boolean
    authorization?: string
    onRequest?: (request: IncomingMessage) => void
  }
  close: () => Promise<void>
}

/**
 * A repository served over git's smart HTTP protocol (`git http-backend`), the
 * protocol a GitHub clone speaks; the dumb protocol cannot answer a shallow
 * fetch. The origin has `commits` commits on `trunk` and a `feature` branch
 * three commits behind it.
 */
export async function serveGitOrigin(commits = 5): Promise<GitOrigin> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "git-origin-"))
  const repository = path.join(directory, "origin.git")
  await mkdir(repository)
  const env = { ...process.env, HOME: directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(directory, "gitconfig") }
  const git = (args: string[], cwd = repository) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git(["init", "--quiet", "--initial-branch=trunk"])
  for (let index = 1; index <= commits; index++) {
    await writeFile(path.join(repository, "hello.txt"), `selected repository ${index}\n`)
    git(["add", "."])
    git(["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "-m", `commit ${index}`])
  }
  git(["branch", "feature", "HEAD~3"])
  const served: GitOrigin["served"] = { reachable: true, uploads: true }
  const server: Server = createServer((request, response) => {
    served.onRequest?.(request)
    const url = new URL(request.url!, "http://localhost")
    const upload = url.pathname.endsWith("/git-upload-pack")
    if (upload && served.stalled) return
    if (!served.reachable || (upload && !served.uploads)) {
      response.writeHead(503).end()
      return
    }
    if (served.authorization && request.headers.authorization !== served.authorization) {
      response.writeHead(401, { "www-authenticate": "Basic realm=\"origin\"" }).end()
      return
    }
    const backend = spawn("git", ["http-backend"], {
      env: {
        ...env,
        GIT_PROJECT_ROOT: directory,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method ?? "GET",
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        ...(request.headers["git-protocol"] ? { GIT_PROTOCOL: String(request.headers["git-protocol"]) } : {}),
        ...(request.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: request.headers["content-encoding"] } : {}),
      },
    })
    request.pipe(backend.stdin)
    const chunks: Buffer[] = []
    backend.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
    backend.on("close", () => {
      const output = Buffer.concat(chunks)
      const split = output.indexOf("\r\n\r\n")
      const headers: Record<string, string> = {}
      let status = 200
      for (const line of output.subarray(0, split).toString().split("\r\n")) {
        const colon = line.indexOf(":")
        const name = line.slice(0, colon).trim()
        const value = line.slice(colon + 1).trim()
        if (name.toLowerCase() === "status") status = Number(value.split(" ")[0])
        else headers[name] = value
      }
      response.writeHead(status, headers).end(output.subarray(split + 4))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as { port: number }
  return {
    directory,
    repoUrl: `http://127.0.0.1:${port}/origin.git`,
    git,
    served,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    },
  }
}
