import { afterAll, describe, expect, test } from "vitest"
import { mkdirSync, realpathSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Hono } from "hono"

const root = path.join(realpathSync(os.tmpdir()), `page-routes-${randomUUID().slice(0, 8)}`)
mkdirSync(root, { recursive: true })
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { ClaxedoDB } = await import("../storage/db")
ClaxedoDB.Drizzle()
const { PagesRoutes } = await import("./pages")

const app = new Hono().route("/pages", PagesRoutes())

async function json(res: Response) {
  return res.json() as Promise<Record<string, unknown>>
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}

async function withOpenCodeFetch<T>(fn: (captured: Record<string, unknown>[]) => Promise<T>) {
  const previousFetch = globalThis.fetch
  const captured: Record<string, unknown>[] = []
  let session = 0
  const fakeFetch = Object.assign(
    async (input: URL | RequestInfo, init?: RequestInit | BunFetchRequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === "/session" && init?.method === "POST") {
        session += 1
        return Response.json({ id: `ses_${session}` })
      }
      if (url.pathname.includes("/message") && init?.method === "POST") {
        captured.push(typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {})
        return Response.json({
          info: { id: `msg_${captured.length}` },
          parts: [{ type: "text", text: "Done.\n@arena:done" }],
        })
      }
      return new Response("unexpected opencode fetch", { status: 500 })
    },
    { preconnect: previousFetch.preconnect },
  )
  globalThis.fetch = fakeFetch
  try {
    return await fn(captured)
  } finally {
    globalThis.fetch = previousFetch
  }
}

async function waitForMessage(captured: Record<string, unknown>[]) {
  for (const _ of Array.from({ length: 20 })) {
    if (captured.length > 0) return captured[0]
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return captured[0]
}

async function createPage(app: Hono, title: string) {
  const res = await app.request("http://localhost/pages?scope=global", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string }
}

async function readSse(res: Response, match: (event: Record<string, unknown>) => boolean) {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (const _ of Array.from({ length: 20 })) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value)
    const events = buffer.split("\n\n")
    buffer = events.pop() ?? ""
    for (const event of events) {
      const data = event
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
      if (!data) continue
      const parsed = JSON.parse(data) as Record<string, unknown>
      if (match(parsed)) {
        await reader.cancel()
        return parsed
      }
    }
  }
  await reader.cancel()
}

describe("PagesRoutes", () => {
  afterAll(async () => {
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    process.env.CLAXEDO_DATA_DIR = prev
  })

  test("returns structured status validation errors", async () => {
    const missingProject = await app.request("http://localhost/pages/statuses?scope=all", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([]),
    })
    expect(missingProject.status).toBe(400)
    await expect(missingProject.json()).resolves.toEqual({
      error: {
        code: "page_project_required",
        message: "project_id is required for all-scope status updates",
      },
    })

    const invalidBody = await app.request("http://localhost/pages/statuses?scope=global", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([]),
    })
    expect(invalidBody.status).toBe(400)
    await expect(invalidBody.json()).resolves.toEqual({
      error: {
        code: "page_statuses_invalid_body",
        message: "Expected non-empty array of statuses",
      },
    })
  })

  test("returns structured page not-found errors", async () => {
    for (const request of [
      new Request("http://localhost/pages/page_missing"),
      new Request("http://localhost/pages/page_missing/session", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: "ses_1" }),
      }),
      new Request("http://localhost/pages/page_missing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Missing" }),
      }),
      new Request("http://localhost/pages/page_missing", { method: "DELETE" }),
    ]) {
      const res = await app.request(request)
      expect(res.status).toBe(404)
      await expect(res.json()).resolves.toEqual({
        error: {
          code: "page_not_found",
          message: "Page not found",
        },
      })
    }
  })

  test("streams page list invalidations after mutations", async () => {
    const stream = await app.request("http://localhost/pages/events?scope=global")
    expect(stream.status).toBe(200)
    const event = readSse(stream, (item) => item.type === "pages.changed")

    await createPage(app, "Streamed")

    await expect(event).resolves.toMatchObject({
      type: "pages.changed",
      project_id: "__pages_global__",
      reason: "create",
    })
  })

  test("returns structured page status transition errors", async () => {
    const missingStatus = await app.request("http://localhost/pages/page_missing/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(missingStatus.status).toBe(400)
    await expect(missingStatus.json()).resolves.toEqual({
      error: {
        code: "page_status_required",
        message: "status is required",
      },
    })

    const created = await app.request("http://localhost/pages?scope=global", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Status errors" }),
    })
    expect(created.status).toBe(201)
    const page = (await json(created)) as { id: string }

    const unknown = await app.request(`http://localhost/pages/${page.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "missing_status" }),
    })
    expect(unknown.status).toBe(422)
    await expect(unknown.json()).resolves.toEqual({
      error: {
        code: "page_status_not_found",
        message: 'Status "missing_status" does not exist',
      },
    })

    const forbidden = await app.request(`http://localhost/pages/${page.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    })
    expect(forbidden.status).toBe(422)
    await expect(forbidden.json()).resolves.toEqual({
      error: {
        code: "page_status_transition_not_allowed",
        message: 'Transition from "draft" to "done" is not allowed',
      },
    })
  })

  test("returns structured page arena errors before arena startup", async () => {
    const page = await createPage(app, "Arena errors")
    const missingText = await app.request(`http://localhost/pages/${page.id}/arena/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(missingText.status).toBe(400)
    await expect(missingText.json()).resolves.toEqual({
      error: {
        code: "page_arena_text_required",
        message: "text is required",
      },
    })

    const missingArena = await app.request(`http://localhost/pages/${page.id}/arena/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Run a review" }),
    })
    expect(missingArena.status).toBe(404)
    await expect(missingArena.json()).resolves.toEqual({
      error: {
        code: "page_arena_not_started",
        message: "Arena not started",
      },
    })

    const control = await app.request(`http://localhost/pages/${page.id}/arena/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "retry" }),
    })
    expect(control.status).toBe(404)
    await expect(control.json()).resolves.toEqual({
      error: {
        code: "page_arena_not_started",
        message: "Arena not started",
      },
    })
  })

  test("uses injected page arena env instead of ambient process env", async () => {
    const prevModel = process.env.PAGES_AI_MODEL
    const prevAgent = process.env.PAGES_ARENA_AGENT
    process.env.PAGES_AI_MODEL = "ambient/provider"
    process.env.PAGES_ARENA_AGENT = "ambient-agent"

    try {
      await withOpenCodeFetch(async () => {
        const isolated = new Hono().route("/pages", PagesRoutes({ env: {} }))
        const page = await createPage(isolated, "Ambient ignored")
        const res = await isolated.request(`http://localhost/pages/${page.id}/arena/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            config: {
              agents: [{ name: "solo", role: "builder", duty: "Build the page." }],
            },
          }),
        })
        expect(res.status).toBe(200)
        const state = (await res.json()) as { agents: Array<{ model: string }> }
        expect(state.agents.map((agent) => agent.model)).toEqual(["opencode/big-pickle"])
      })

      await withOpenCodeFetch(async (captured) => {
        const injected = new Hono().route(
          "/pages",
          PagesRoutes({
            env: {
              PAGES_AI_MODEL: "provider/injected",
              PAGES_ARENA_AGENT: "injected-agent",
            },
          }),
        )
        const page = await createPage(injected, "Injected arena")
        const start = await injected.request(`http://localhost/pages/${page.id}/arena/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            config: {
              agents: [{ name: "solo", role: "builder", duty: "Build the page." }],
            },
          }),
        })
        expect(start.status).toBe(200)
        const state = (await start.json()) as { agents: Array<{ model: string }> }
        expect(state.agents.map((agent) => agent.model)).toEqual(["provider/injected"])

        const message = await injected.request(`http://localhost/pages/${page.id}/arena/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "Ship it" }),
        })
        expect(message.status).toBe(200)
        expect(await waitForMessage(captured)).toMatchObject({
          agent: "injected-agent",
          model: {
            providerID: "provider",
            modelID: "injected",
          },
        })
      })
    } finally {
      restoreEnv("PAGES_AI_MODEL", prevModel)
      restoreEnv("PAGES_ARENA_AGENT", prevAgent)
    }
  })

  test("rejects a second arena message while a wave is processing", async () => {
    const previousFetch = globalThis.fetch
    let releasePrompt = () => {}
    const promptStarted = new Promise<void>((resolve) => {
      const fakeFetch = Object.assign(
        async (input: URL | RequestInfo, init?: RequestInit | BunFetchRequestInit) => {
          const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
          if (url.pathname === "/session" && init?.method === "POST") return Response.json({ id: "ses_busy" })
          if (url.pathname.includes("/message") && init?.method === "POST") {
            resolve()
            await new Promise<void>((done, reject) => {
              releasePrompt = done
              init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
            })
            return Response.json({ parts: [{ type: "text", text: "Done.\n@arena:done" }] })
          }
          return new Response("unexpected opencode fetch", { status: 500 })
        },
        { preconnect: previousFetch.preconnect },
      )
      globalThis.fetch = fakeFetch
    })

    try {
      const page = await createPage(app, "Busy arena")
      const start = await app.request(`http://localhost/pages/${page.id}/arena/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: { agents: [{ name: "solo", role: "builder", duty: "Build" }] } }),
      })
      expect(start.status).toBe(200)

      const first = await app.request(`http://localhost/pages/${page.id}/arena/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "First" }),
      })
      expect(first.status).toBe(200)
      await promptStarted

      const second = await app.request(`http://localhost/pages/${page.id}/arena/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Second" }),
      })
      expect(second.status).toBe(409)
      await expect(second.json()).resolves.toMatchObject({
        error: { code: "page_arena_busy" },
      })

      const stop = await app.request(`http://localhost/pages/${page.id}/arena/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      })
      expect(stop.status).toBe(200)
    } finally {
      releasePrompt()
      globalThis.fetch = previousFetch
    }
  })
})
