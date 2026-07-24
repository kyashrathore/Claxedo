import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Hono } from "hono"
import { SessionEnvRoutes, SESSION_ENV_GREP_MAX_FILE_BYTES } from "./session-env"
import { errorBody, JSON_BODY_LIMIT_BYTES } from "./http"
import {
  createProcessObserver,
  type ProcessObserver,
  type ProcessObserverEvent,
} from "../managed-processes/process-observer"

const prevDir = process.env.WORKSPACE_RUNTIME_DIRECTORY

async function temp() {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "session-env-"))
  process.env.WORKSPACE_RUNTIME_DIRECTORY = directory
  return directory
}

function app(processObserver?: ProcessObserver) {
  const out = new Hono()
  out.route("/api/wr/session-env", SessionEnvRoutes(processObserver))
  return out
}

function url(route: string, directory: string) {
  return `http://localhost/api/wr/session-env${route}${route.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`
}

async function ndjson(res: Response) {
  return (await res.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
}

function signalIgnoringCommand() {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify([
    "process.stdout.write(String(process.pid) + '\\n')",
    "process.on('SIGTERM', () => {})",
    "setInterval(() => {}, 1000)",
  ].join(";"))}`
}

function pidFromEvent(event: Record<string, unknown>) {
  return Number(Buffer.from(event.data as string, "base64").toString().trim())
}

async function waitForGone(pid: number) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`process ${pid} is still alive`)
}

async function readStdoutEvent(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error("stream ended before stdout")
    buffer += decoder.decode(chunk.value)
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line) continue
      const event = JSON.parse(line) as Record<string, unknown>
      if (event.type === "stdout") return event
    }
  }
}

describe("SessionEnvRoutes", () => {
  afterEach(() => {
    process.env.WORKSPACE_RUNTIME_DIRECTORY = prevDir
  })

  test("reads, writes, stats, lists, globs, and greps inside the pinned workspace", async () => {
    const directory = await temp()
    const server = app()

    const write = await server.request(url("/file/write", directory), {
      method: "POST",
      body: JSON.stringify({ path: "src/app.ts", content: "export const value = 1\n" }),
      headers: { "Content-Type": "application/json" },
    })
    expect(write.status).toBe(200)

    const read = await server.request(url("/file/read?path=src/app.ts", directory))
    expect(Buffer.from((await read.json() as { content: string }).content, "base64").toString()).toBe("export const value = 1\n")

    const stat = await server.request(url("/file/stat?path=src", directory))
    expect(await stat.json()).toMatchObject({ isDirectory: true })

    const rows = await server.request(url("/file/readdir?path=src", directory))
    expect(await rows.json()).toEqual(["app.ts"])

    const glob = await server.request(url("/glob", directory), {
      method: "POST",
      body: JSON.stringify({ pattern: "**/*.ts" }),
      headers: { "Content-Type": "application/json" },
    })
    expect(await glob.json()).toEqual({ paths: ["src/app.ts"] })

    const grep = await server.request(url("/grep", directory), {
      method: "POST",
      body: JSON.stringify({ pattern: "value", path: "src", literal: true }),
      headers: { "Content-Type": "application/json" },
    })
    expect(await grep.json()).toMatchObject({
      matches: [{ path: "app.ts", line: 1, text: "export const value = 1" }],
      limitReached: false,
    })
  })

  test("rejects path escapes", async () => {
    const directory = await temp()
    const res = await app().request(url(`/file/read?path=${encodeURIComponent(path.join(directory, "..", "nope"))}`, directory))
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "session_env_path_forbidden",
        message: "workspace path must be relative",
      },
    })
  })

  test("rejects mismatched directories and absolute workspace paths", async () => {
    const directory = await temp()
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), "session-env-outside-"))
    try {
      const wrongDirectory = await app().request(url("/file/read?path=src/app.ts", outside))
      expect(wrongDirectory.status).toBe(400)
      await expect(wrongDirectory.json()).resolves.toEqual({
        error: {
          code: "session_env_invalid_directory",
          message: "Session env directory must match configured workspace",
        },
      })

      const absoluteInside = await app().request(
        url(`/file/read?path=${encodeURIComponent(path.join(directory, "src", "app.ts"))}`, directory),
      )
      expect(absoluteInside.status).toBe(403)
      await expect(absoluteInside.json()).resolves.toEqual({
        error: {
          code: "session_env_path_forbidden",
          message: "workspace path must be relative",
        },
      })
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true })
    }
  })

  test("returns structured validation errors", async () => {
    const directory = await temp()
    const server = app()

    const exec = await server.request(url("/exec", directory), {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    })
    expect(exec.status).toBe(400)
    await expect(exec.json()).resolves.toEqual({
      error: {
        code: "session_env_command_required",
        message: "Missing command",
      },
    })

    for (const route of ["/glob", "/grep"]) {
      const res = await server.request(url(route, directory), {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      })
      expect(res.status).toBe(400)
      await expect(res.json()).resolves.toEqual({
        error: {
          code: "session_env_pattern_required",
          message: "Missing pattern",
        },
      })
    }
  })

  test("attributes Pi SessionEnv children by session without retaining shell text", async () => {
    const directory = await temp()
    const sentinel = "session-env-observer-sentinel"
    const events: ProcessObserverEvent[] = []
    const observer = createProcessObserver({ sink: (event) => events.push(event) })
    const response = await app(observer).request(url("/exec", directory), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        command: `printf ${sentinel}`,
        sessionId: "session-safe",
      }),
    })

    expect(response.status).toBe(200)
    await response.text()
    expect(events[0]).toMatchObject({
      type: "registered",
      descriptor: {
        kind: "session-shell",
        sessionId: "session-safe",
        parentOwnerId: "pi-session:session-safe",
        label: "Session tool shell",
      },
    })
    expect(JSON.stringify(events)).not.toContain(sentinel)
    expect(events.some((event) => event.type === "exited")).toBeTrue()
    observer.dispose()
  })

  test("rejects oversized session-env write bodies", async () => {
    const directory = await temp()
    const response = await app().request(url("/file/write", directory), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(JSON_BODY_LIMIT_BYTES + 1),
      },
      body: JSON.stringify({ path: "src/app.ts", content: "small" }),
    })

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toEqual(errorBody("request_body_too_large", "Request body is too large"))
    await expect(fs.promises.stat(path.join(directory, "src", "app.ts"))).rejects.toThrow()
  })

  test("rejects unsafe grep regex patterns", async () => {
    const directory = await temp()
    await fs.promises.writeFile(path.join(directory, "input.txt"), "aaaa\n")
    const response = await app().request(url("/grep", directory), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "input.txt", pattern: "(a+)+$" }),
    })

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual(errorBody("session_env_unsafe_regex", "Unsafe grep pattern"))
  })

  test("skips oversized grep files", async () => {
    const directory = await temp()
    await fs.promises.writeFile(path.join(directory, "huge.txt"), `needle${"x".repeat(SESSION_ENV_GREP_MAX_FILE_BYTES)}`)
    const response = await app().request(url("/grep", directory), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: ".", pattern: "needle", literal: true }),
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      matches: [],
      limitReached: false,
      skippedFiles: 1,
    })
  })

  test("streams exec output as ndjson", async () => {
    const directory = await temp()
    const res = await app().request(url("/exec", directory), {
      method: "POST",
      body: JSON.stringify({ command: "printf hello" }),
      headers: { "Content-Type": "application/json" },
    })
    expect(res.status).toBe(200)
    const events = await ndjson(res)
    expect(Buffer.from(events[0]!.data as string, "base64").toString()).toBe("hello")
    expect(events.at(-1)).toMatchObject({ type: "exit", exitCode: 0 })
  })

  test("exec timeout escalates to SIGKILL for signal-ignoring process groups", async () => {
    const directory = await temp()
    const res = await app().request(url("/exec", directory), {
      method: "POST",
      body: JSON.stringify({ command: signalIgnoringCommand(), timeout: 50 }),
      headers: { "Content-Type": "application/json" },
    })

    expect(res.status).toBe(200)
    const events = await ndjson(res)
    const pid = pidFromEvent(events.find((event) => event.type === "stdout")!)
    await waitForGone(pid)
    expect(events.at(-1)).toMatchObject({ type: "exit", timedOut: true, escalated: true })
  })

  test("exec stream cancellation kills signal-ignoring process groups", async () => {
    const directory = await temp()
    const res = await app().request(url("/exec", directory), {
      method: "POST",
      body: JSON.stringify({ command: signalIgnoringCommand() }),
      headers: { "Content-Type": "application/json" },
    })

    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const pid = pidFromEvent(await readStdoutEvent(reader))
    await reader.cancel()
    await waitForGone(pid)
  })

  test("canceling a streaming exec response does not raise an unhandled rejection", async () => {
    const directory = await temp()
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => rejections.push(reason)
    process.on("unhandledRejection", onRejection)
    try {
      const res = await app().request(url("/exec", directory), {
        method: "POST",
        // Emit its pid, then keep streaming continuous output so a late chunk
        // can race the cancel() and hit the (now guarded) enqueue path.
        body: JSON.stringify({
          command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify([
            "process.stdout.write(String(process.pid) + '\\n')",
            "setInterval(() => process.stdout.write('x'.repeat(1024) + '\\n'), 5)",
          ].join(";"))}`,
        }),
        headers: { "Content-Type": "application/json" },
      })
      expect(res.status).toBe(200)

      const reader = res.body!.getReader()
      const pid = pidFromEvent(await readStdoutEvent(reader))
      await reader.cancel()

      // Give any late 'data' chunks a chance to fire against the canceled stream.
      await new Promise((resolve) => setTimeout(resolve, 50))
      await waitForGone(pid)
      expect(rejections).toEqual([])
    } finally {
      process.off("unhandledRejection", onRejection)
    }
  })

  test("filters exec env through the PTY safe-env policy", async () => {
    const directory = await temp()
    process.env.CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN = "ambient-secret"
    const res = await app().request(url("/exec", directory), {
      method: "POST",
      body: JSON.stringify({
        command: [
          "node -e 'process.stdout.write(JSON.stringify({",
          "nodeOptions: process.env.NODE_OPTIONS || null,",
          "opencode: process.env.OPENCODE_ALLOWED || null,",
          "secret: process.env.SECRET_TOKEN || null,",
          "installation: process.env.CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN || null",
          "}))'",
        ].join(" "),
        env: {
          NODE_OPTIONS: "--require /definitely-missing-workspace-runtime-module",
          OPENCODE_ALLOWED: "yes",
          SECRET_TOKEN: "nope",
          CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN: "request-secret",
        },
      }),
      headers: { "Content-Type": "application/json" },
    })
    expect(res.status).toBe(200)
    const events = await ndjson(res)
    expect(JSON.parse(Buffer.from(events[0]!.data as string, "base64").toString())).toEqual({
      nodeOptions: null,
      opencode: "yes",
      secret: null,
      installation: null,
    })
    expect(events.at(-1)).toMatchObject({ type: "exit", exitCode: 0 })
  })
})
