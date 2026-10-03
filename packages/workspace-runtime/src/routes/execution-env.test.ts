import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { generateKeyPair } from "jose"
import { mintRelayHostToken } from "@claxedo/workspace-relay"
import { executionEnvApp, type ExecutionEnvClaims } from "../test-support/execution-env-server"
import { createWorkspaceRuntimeApp } from "../server"
import { relayWorkspaceRuntimeExposure } from "../exposure"
import { loopbackMachineLoginPolicy } from "../testing"

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function tempDir() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wr-execution-env-")))
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

async function served(env?: NodeJS.ProcessEnv) {
  const directory = await tempDir()
  const { app, headers } = await executionEnvApp({ directory, ...(env ? { env } : {}) })
  const post = async (route: string, body: unknown, claims: ExecutionEnvClaims = { sessionId: "ses_1" }) =>
    app.request(`http://localhost/api/wr/execution-env/${route}`, {
      method: "POST", headers: { ...await headers(claims), "content-type": "application/json" }, body: JSON.stringify(body),
    })
  const fsOp = async (op: string, ...args: unknown[]) => (await post("fs", { op, args })).json()
  const status = async (...input: Parameters<typeof post>) => (await post(...input)).status
  return { directory, post, fsOp, status }
}

type SseEvent = { event: string; data: any }

function parseSse(text: string): SseEvent[] {
  return text.split("\n\n").filter((block) => block.trim()).map((block) => {
    const lines = block.split("\n")
    return {
      event: lines.find((line) => line.startsWith("event: "))!.slice(7),
      data: JSON.parse(lines.find((line) => line.startsWith("data: "))!.slice(6)),
    }
  })
}

describe("execution-env fs", () => {
  test("read, write and edit round-trip through the workspace directory, with binary as base64", async () => {
    const { directory, fsOp } = await served()
    expect(await fsOp("createDir", "notes", { recursive: true })).toEqual({ ok: true })
    expect(await fsOp("writeFile", "notes/a.txt", "alpha\nbeta\n")).toEqual({ ok: true })
    expect(await fsOp("readTextFile", "notes/a.txt")).toEqual({ ok: true, value: "alpha\nbeta\n" })
    expect(await fsOp("writeFile", "notes/a.txt", "alpha\ngamma\n")).toEqual({ ok: true })
    expect(await fsOp("readTextLines", "notes/a.txt", { maxLines: 1 })).toEqual({ ok: true, value: ["alpha"] })
    expect(await fsOp("readTextLines", "notes/a.txt", null)).toEqual({ ok: true, value: ["alpha", "gamma"] })
    expect(await fs.readFile(path.join(directory, "notes/a.txt"), "utf8")).toBe("alpha\ngamma\n")
    const bytes = Buffer.from([0, 1, 2, 255])
    expect(await fsOp("writeFile", "notes/b.bin", { base64: bytes.toString("base64") })).toEqual({ ok: true })
    expect(await fsOp("readBinaryFile", "notes/b.bin")).toEqual({ ok: true, value: { base64: bytes.toString("base64") } })
    expect(await fsOp("absolutePath", "notes")).toEqual({ ok: true, value: path.join(directory, "notes") })
    expect((await fsOp("listDir", "notes")).value.map((entry: { name: string }) => entry.name).sort()).toEqual(["a.txt", "b.bin"])
    expect(await fsOp("readTextFile", "missing.txt")).toMatchObject({ ok: false, error: { code: "not_found" } })
  })

  test("an unknown operation or malformed arguments answer 400", async () => {
    const { status } = await served()
    expect(await status("fs", { op: "openTextLineReader", args: ["a"] })).toBe(400)
    expect(await status("fs", { op: "cleanup", args: [] })).toBe(400)
    expect(await status("fs", { op: "readTextFile", args: [42] })).toBe(400)
    expect(await status("fs", { op: "writeFile", args: ["a", { base64: "AA==", extra: true }] })).toBe(400)
  })
})

describe("execution-env exec", () => {
  test("streams output events, then the result", async () => {
    const { post } = await served()
    const response = await post("exec", { command: "printf one; printf two >&2; exit 3" })
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const events = parseSse(await response.text())
    expect(events.filter((event) => event.event === "output").map((event) => event.data.text).join("")).toContain("one")
    expect(events.filter((event) => event.event === "output").map((event) => event.data.text).join("")).toContain("two")
    expect(events.at(-1)).toEqual({ event: "result", data: { ok: true, value: { exitCode: 3 } } })
  })

  test("a timeout ends the command with a timeout error", async () => {
    const { post } = await served()
    const events = parseSse(await (await post("exec", { command: "exec sleep 30", timeout: 0.2 })).text())
    expect(events.at(-1)).toEqual({ event: "result", data: { ok: false, error: { code: "timeout", message: "Command timed out after 0.2 seconds" } } })
  })

  test("runtime secrets in the host env never reach the command", async () => {
    const { post } = await served({
      PATH: process.env.PATH, VISIBLE_MARKER: "visible", CLAXEDO_RELAY_PRIVATE_KEY: "relay-secret",
      WORKSPACE_RUNTIME_MANAGEMENT_TOKEN: "management-secret", CLAXEDO_WORKSPACE_ID: "ws_1",
    })
    const output = parseSse(await (await post("exec", { command: "env" })).text())
      .filter((event) => event.event === "output").map((event) => event.data.text).join("")
    expect(output).toContain("VISIBLE_MARKER=visible")
    expect(output).toContain("CLAXEDO_WORKSPACE_ID=ws_1")
    expect(output).not.toContain("relay-secret")
    expect(output).not.toContain("management-secret")
  })
})

describe("execution-env access", () => {
  test("refuses a token without a session or with viewer role, and hides itself from other backings", async () => {
    const { status } = await served()
    expect(await status("fs", { op: "exists", args: ["."] }, {})).toBe(403)
    expect(await status("fs", { op: "exists", args: ["."] }, { sessionId: "ses_1", role: "viewer" })).toBe(403)
    expect(await status("fs", { op: "exists", args: ["."] }, { sessionId: "ses_1", backing: "local-worktree" })).toBe(404)
    expect(await status("exec", { command: "true" }, { sessionId: "ses_1", backing: "local-worktree" })).toBe(404)
  })
})

describe("execution-env on the composed relay runtime", () => {
  test("is mounted behind relay-host auth and spawns under the workspace's launch ownership", async () => {
    const directory = await tempDir()
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const relayHostAuth = { key: key.publicKey, workspaceId: "ws_1", hostId: "host_1" }
    const runtime = createWorkspaceRuntimeApp({
      sessionIdWorkspace: () => undefined,
      placement: loopbackMachineLoginPolicy(),
      exposure: relayWorkspaceRuntimeExposure(relayHostAuth),
      target: { workspaceId: "ws_1", directory },
      storeRoot: path.join(directory, ".store"),
    })
    cleanups.push(() => runtime.dispose())
    const token = await mintRelayHostToken({ principalKind: "user", actorId: "actor_1", actorKind: "human", orgId: "org_1",
      workspaceId: "ws_1", hostId: "host_1", role: "editor", backing: "cloud-vm", parentJti: "rat_1", sessionId: "ses_1" }, key.privateKey, "EdDSA")
    const request = (route: string, body: unknown) => runtime.app.request(`http://localhost/api/wr/execution-env/${route}`, {
      method: "POST", body: JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, "x-workspace-id": "ws_1", "x-forwarded-by": "workspace-relay", "content-type": "application/json" },
    })
    expect(await (await request("fs", { op: "writeFile", args: ["proof.txt", "from the DO"] })).json()).toEqual({ ok: true })
    const events = parseSse(await (await request("exec", { command: "cat proof.txt" })).text())
    expect(events.filter((event) => event.event === "output").map((event) => event.data.text).join("")).toBe("from the DO")
    expect(events.at(-1)).toEqual({ event: "result", data: { ok: true, value: { exitCode: 0 } } })
    expect((await runtime.app.request("http://localhost/api/wr/execution-env/fs", { method: "POST" })).status).toBe(401)
    const outside = await request("other", {})
    expect(outside.status).toBe(403)
    expect(await outside.json()).toMatchObject({ error: { code: "relay_scope_denied" } })
  })
})
