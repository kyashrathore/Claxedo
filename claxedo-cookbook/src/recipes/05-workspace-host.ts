// WHAT: Boot one loopback Workspace Host (createWorkspaceRuntimeApp) on a free
//       port and tour its route families over plain fetch: health, file
//       search/list, git-backed file write + read back, VCS diff, managed
//       processes with captured output, and the live runtime event stream.
// RUN:  bun run recipe:05-workspace-host   (runs: tsx src/recipes/05-workspace-host.ts)
// NEEDS: git on PATH. No API keys, no agent, no LLM, no docker.
// WOW:  one Workspace Host is workspace INFRASTRUCTURE, not just chat — six
//       route families against a sandboxed temp workspace, deterministic and
//       done in seconds.
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { serve } from "@hono/node-server"
import { createWorkspaceRuntimeApp, loopbackWorkspaceRuntimeExposure } from "@claxedo/workspace-runtime"
import { banner, freePort, hasBinary, printResult, skip, waitForHttp } from "./_shared"

const MARKER = "hello-from-managed-process"

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" })
}

/** SAFETY: the host serves a fresh temp dir seeded with two files — never this repo. */
async function seedWorkspace() {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "claxedo-workspace-host-"))
  await fs.writeFile(path.join(dir, "notes.md"), "# release notes\n\n- v0.1: first cut\n")
  await fs.writeFile(path.join(dir, "README.md"), "# demo workspace\n\nSeeded by the cookbook tour.\n")
  git(dir, "init", "-q")
  git(dir, "config", "user.email", "cookbook@example.com")
  git(dir, "config", "user.name", "Claxedo Cookbook")
  git(dir, "config", "commit.gpgsign", "false")
  git(dir, "add", ".")
  git(dir, "commit", "-q", "-m", "seed workspace")
  return dir
}

/** Strip OSC + CSI + bare escape sequences from raw PTY output. */
function stripAnsi(input: string) {
  return input
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC (window title etc.), BEL/ST terminated
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "") // CSI (colors, cursor movement)
    .replace(/\x1b[@-_]/g, "") // bare two-char escapes
}

type RuntimeEvent = { type: string } & Record<string, unknown>

/** Subscribe to the /api/wr/events SSE stream and collect parsed events. */
function subscribeEvents(base: string) {
  const controller = new AbortController()
  const events: RuntimeEvent[] = []
  const done = (async () => {
    const response = await fetch(`${base}/api/wr/events`, {
      signal: controller.signal,
      headers: { accept: "text/event-stream" },
    })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      while (true) {
        const { done: finished, value } = await reader.read()
        if (finished) break
        buffer += decoder.decode(value, { stream: true })
        let split
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, split)
          buffer = buffer.slice(split + 2)
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n")
          if (data) events.push(JSON.parse(data) as RuntimeEvent)
        }
      }
    } catch {
      // aborted at the end of the tour
    }
  })()
  return { events, close: () => controller.abort(), done }
}

async function json(base: string, route: string, init?: RequestInit) {
  const response = await fetch(`${base}${route}`, init)
  return (await response.json()) as Record<string, unknown>
}

async function main() {
  banner({
    recipe: "05-workspace-host",
    what: "boot one loopback Workspace Host and tour six /api/wr/* route families over plain fetch",
    wow: "one host = workspace infrastructure: files, search, git, diffs, processes, events — no agent required",
  })

  if (!hasBinary("git")) {
    skip("git is not on PATH (the diff and git route families shell out to git)", "install git and re-run")
  }

  const workspace = await seedWorkspace()
  const runtime = createWorkspaceRuntimeApp({
    exposure: loopbackWorkspaceRuntimeExposure(),
    target: { workspaceId: "cookbook-tour", directory: workspace },
    storeRoot: path.join(workspace, ".claxedo-store"),
  })
  const port = await freePort()
  const server = serve({ fetch: runtime.app.fetch, port, hostname: "127.0.0.1" })
  runtime.injectWebSocket(server)
  const base = `http://127.0.0.1:${port}`
  await waitForHttp(`${base}/api/wr/health`)
  console.log(`workspace host is serving ${workspace}`)
  console.log(`tour base url: ${base} (route prefix /api/wr)`)

  // Stop 1 — health.
  printResult("stop 1: GET /api/wr/health", await json(base, "/api/wr/health"))

  // Stop 2 — file list + fuzzy file search.
  printResult("stop 2: files — GET /api/wr/file/all + GET /api/wr/find/file?query=notes", {
    all: await json(base, "/api/wr/file/all"),
    search: await json(base, "/api/wr/find/file?query=notes"),
  })

  // Stop 3 — git-backed file write, then read the content back.
  // /api/wr/git/commit is compare-and-swap: it needs the current head + blob
  // sha from /api/wr/git/snapshot, writes the file, and commits it atomically.
  const snapshot = await json(base, "/api/wr/git/snapshot?path=notes.md")
  const commit = await json(base, "/api/wr/git/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: "notes.md",
      content: "# release notes\n\n- v0.1: first cut\n- v0.2: written over HTTP\n",
      message: "docs: add v0.2 line over the wire",
      expected: { baseCommit: snapshot.head, baseBlobSha: snapshot.blobSha },
    }),
  })
  printResult("stop 3: git-backed write — POST /api/wr/git/commit + GET /api/wr/file/content?path=notes.md", {
    commit,
    readBack: await json(base, "/api/wr/file/content?path=notes.md"),
  })

  // Stop 4 — modify a seeded file on disk (like an agent would), then diff it.
  await fs.appendFile(path.join(workspace, "README.md"), "\nEdited after the seed commit.\n")
  printResult(
    "stop 4: GET /api/wr/diff/vcs?content=summary (uncommitted)",
    await json(base, "/api/wr/diff/vcs?content=summary"),
  )

  // Stop 5 — managed processes: register a config (like a dev server), start
  // it, and read its captured PTY output back over HTTP.
  const listener = subscribeEvents(base)
  const config = await json(base, "/api/wr/process", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "hello", command: `echo ${MARKER} && sleep 30` }),
  })
  const start = await json(base, `/api/wr/process/${config.id}/start`, { method: "POST" })
  let logLine = ""
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline && !logLine) {
    const logs = await fetch(`${base}/api/wr/process/logs?process_id=${config.id}&lines=200`).then((r) => r.text())
    logLine = stripAnsi(logs)
      .split(/\r?\n|\r/)
      .map((line) => line.trim())
      // the shell also echoes the typed command; keep the line that IS the output
      .find((line) => line === MARKER) ?? ""
    if (!logLine) await new Promise((resolve) => setTimeout(resolve, 700))
  }
  printResult("stop 5: managed process — POST /api/wr/process + /start + GET /api/wr/process/logs", {
    config: { id: config.id, name: config.name, command: config.command },
    start: { kind: start.kind },
    capturedOutput: logLine,
  })

  // Stop 6 — the same actions were broadcast on the runtime event stream.
  await new Promise((resolve) => setTimeout(resolve, 500))
  listener.close()
  await listener.done
  printResult(
    "stop 6: GET /api/wr/events (SSE) — events observed while the process started",
    listener.events
      .filter((event) => event.type !== "heartbeat" && event.type !== "pty.stream")
      .map((event) => ({
        type: event.type,
        ...(event.configId !== undefined ? { configId: event.configId } : {}),
        ...(event.status !== undefined ? { status: event.status } : {}),
      })),
  )

  // Clean shutdown: stop workspace processes, close the server, drop the host.
  await fetch(`${base}/api/wr/process/stop-all`, { method: "POST" })
  server.close()
  runtime.host.dispose()
  console.log("tour complete — workspace host shut down cleanly")
  process.exit(0)
}

main().catch((err) => {
  console.error(`recipe failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
