import { expect, test } from "bun:test"
import { Hono } from "hono"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createWorkspaceHost } from "./runtime"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { withWorkspaceTarget } from "../target"

const body = (value: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) })
async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) { const value = await read(); if (accepts(value)) return value; await new Promise(resolve => setTimeout(resolve, 5)) }
  throw new Error("Expected wire interaction did not arrive")
}

test.each(["accept", "decline"] as const)("draft initialization uses ordinary durable question routes (%s)", async (action) => {
  const directory = await mkdtemp(join(tmpdir(), "draft-connection-wire-"))
  const host = createWorkspaceHost({ target: { workspaceId: "ws", directory }, storeRoot: join(directory, "state") })
  const app = new Hono()
  host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
  const request = (path: string, init?: RequestInit) => withWorkspaceTarget({ workspaceId: "ws", directory }, () => app.request(path, init))
  try {
    await host.apply({ version: 4, mcp: {}, auth: {}, connections: [{ connectionId: "draft-agent", providerKey: "acp", configRevision: 1, enabled: true, config: { label: "Fixture", modelSelection: { status: "unsupported" }, connection: { kind: "process", command: process.execPath, args: [fileURLToPath(new URL("./fixtures/acp-initialize-question-peer.mjs", import.meta.url))] } } }], defaultHarness: { kind: "connection", connectionId: "draft-agent" } })
    const creating = request(`/session?directory=${encodeURIComponent(directory)}`, body({ id: "draft-session", title: "Explicit draft" }))
    const readStart = () => Promise.resolve(request(`/session-start/draft-session?directory=${encodeURIComponent(directory)}`)).then(response => response.json())
    const start = await until(readStart, result => result.status === "starting")
    expect(start.binding).toMatchObject({ connectionId: "connection:draft-agent" })
    const questions = () => Promise.resolve(request("/question?sessionId=draft-session")).then(response => response.json())
    const pending = await until(questions, result => Array.isArray(result) && result.length === 1)
    const question = pending[0]
    expect(question.sessionID).toBe("draft-session")
    expect(question.questions[0]).toMatchObject({ custom: true, options: [] })
    expect(question.questions[0]).not.toHaveProperty("elicitation")
    expect((await readStart()).binding).toEqual(start.binding)
    expect((await questions())[0].id).toBe(question.id)
    if (action === "decline") {
      expect((await request(`/question/${question.id}/reject`, body({}))).status).toBe(200)
      expect((await creating).status).toBe(500)
      expect((await readStart()).status).toBe("failed")
      expect(await questions()).toEqual([])
      expect((await request(`/question/${question.id}/reply`, body({ answers: [[JSON.stringify({ label: "late" })]] })) ).status).toBe(404)
      return
    }
    const invalid = await request(`/question/${question.id}/reply`, body({ answers: [[JSON.stringify({ label: 42 })]] }))
    expect(invalid.status).toBe(400)
    expect((await questions())[0].id).toBe(question.id)
    const reply = await request(`/question/${question.id}/reply`, body({ answers: [[JSON.stringify({ label: "Draft" })]] }))
    expect(reply.status).toBe(200)
    expect((await creating).status).toBe(201)
    expect((await readStart()).status).toBe("created")
    expect(await questions()).toEqual([])
    expect((await request(`/question/${question.id}/reply`, body({ answers: [[JSON.stringify({ label: "late" })]] })) ).status).toBe(404)
  } finally { await host.dispose(); await rm(directory, { recursive: true, force: true }) }
}, 10_000)
