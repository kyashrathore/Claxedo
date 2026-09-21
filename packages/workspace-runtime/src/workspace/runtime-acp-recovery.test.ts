import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Hono } from "hono"
import { createWorkspaceHost } from "./runtime"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { withWorkspaceTarget } from "../target"

for (const recovery of ["resume", "missing", "auth", "unsupported", "approval", "cancel"]) {
  test(`public ACP history survives runtime restart; restoration outcome ${recovery}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-acp-recovery-"))
    const target = { workspaceId: "recovery-workspace", directory }
    const logFile = join(directory, "peer.jsonl")
    const peer = fileURLToPath(new URL("./fixtures/acp-recovery-peer.mjs", import.meta.url))
    const config = { version: 4 as const, auth: {}, mcp: {}, connections: [{ connectionId: "recovery", providerKey: "acp", configRevision: 1, enabled: true, config: { label: "Recovery peer", connection: { kind: "process", command: "node", args: [peer, logFile, recovery] } } }], defaultHarness: { kind: "connection" as const, connectionId: "recovery" } }
    const open = async () => {
      const host = createWorkspaceHost({ target, storeRoot: join(directory, "store") })
      await host.apply(config)
      const app = new Hono()
      host.mount(app, { exposure: loopbackWorkspaceRuntimeExposure() })
      const request = (pathname: string, method = "GET", body?: unknown) => withWorkspaceTarget(target, () => app.request(
        `http://runtime.test${pathname}?directory=${encodeURIComponent(directory)}`,
        { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) },
      ))
      return { host, request }
    }
    let active = await open()
    try {
      expect((await active.request("/session", "POST", { id: "saved", title: "Recovery acceptance" })).status).toBe(201)
      expect(await (await active.request("/session/saved")).json()).toMatchObject({ title: "Recovery acceptance", titleSource: "user" })
      if (recovery === "cancel") {
        const waiting = active.request("/session/saved/message", "POST", { parts: [{ type: "text", text: "Wait for cancellation." }] })
        let observed = false
        for (let n = 0; n < 200 && !observed; n++) {
          observed = JSON.stringify(await (await active.request("/session/saved/message")).json()).includes("Persisted recovery-peer answer.")
          if (!observed) await Bun.sleep(5)
        }
        expect(observed).toBe(true)
        // The caller reads the turn it means to stop and sends that identity
        // back unchanged; a target it invented would be refused.
        const inspected = await (await active.request("/session/saved/recovery")).json()
        expect(inspected.target).toMatchObject({ scope: "turn", sessionId: "saved" })

        const previousTimeout = process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
        let operation: Record<string, any>
        try {
          // The peer holds its prompt, so the cancel notification is never
          // acknowledged inside this window.
          process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = "50"
          const stopped = await active.request("/session/saved/recovery", "POST", {
            requestId: `req-${Date.now()}`,
            action: "cancel_turn",
            target: inspected.target,
            scopeRevision: "1",
            attempt: 1,
          })
          expect(stopped.status).toBe(200)
          const outcome = await stopped.json()
          expect(outcome.kind).toBe("operation")
          operation = outcome.operation
        } finally {
          if (previousTimeout === undefined) delete process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
          else process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = previousTimeout
        }
        // Nothing established that the peer stopped, so the operation does not
        // succeed and execution stays unknown. A "cancelled" answer here would
        // be the exact lie this contract exists to prevent.
        expect(operation.state).not.toBe("succeeded")
        expect(operation.facts.execution.value).toBe("unknown")
        expect(operation.action).toBe("cancel_turn")

        // The same operation is readable by its receipt, with the same facts.
        const reread = await (await active.request(`/session/saved/recovery/operations/${operation.operationId}`)).json()
        expect(reread.operation.facts.execution.value).toBe("unknown")

        // An unresolved cancellation is retained where an owner can see it.
        const afterStop = await (await active.request("/session/saved/recovery")).json()
        expect(afterStop.operations.some((row: { operationId: string }) => row.operationId === operation.operationId)).toBe(true)
        expect((await active.request("/session/saved/message", "POST", { parts: [{ type: "text", text: "Must not run." }] })).status).toBe(409)
        expect((await active.request("/session", "POST", { id: "sibling", title: "Sibling acceptance" })).status).toBe(201)
        expect((await active.request("/session/sibling/message", "POST", { parts: [{ type: "text", text: "Independent sibling." }] })).status).toBe(200)
        await writeFile(logFile + ".release", "release")
        await (await waiting).text()
        expect(JSON.stringify(await (await active.request("/session/saved/message")).json())).toContain("Late output after cancellation.")
        expect((await active.request("/session/saved/message", "POST", { parts: [{ type: "text", text: "Continue after settlement." }] })).status).toBe(200)
        const log = (await readFile(logFile, "utf8")).trim().split("\n").map(line => JSON.parse(line))
        expect(log.filter(row => row.method === "session/prompt")).toHaveLength(3)
        expect(new Set(log.map(row => row.pid)).size).toBe(1)
        expect(JSON.stringify(log)).not.toContain("Must not run.")
        return
      }
      if (recovery === "approval") {
        const waiting = active.request("/session/saved/message", "POST", { parts: [{ type: "text", text: "Wait for approval." }] })
        let permissions: Array<{ id: string }> = []
        for (let n = 0; n < 200 && !permissions.length; n++) {
          permissions = await (await active.request("/permission")).json()
          if (!permissions.length) await Bun.sleep(5)
        }
        expect(permissions).toHaveLength(1)
        await active.host.dispose()
        await (await waiting).text()
        active = await open()
        expect(await (await active.request("/permission")).json()).toEqual([])
        expect((await active.request(`/session/saved/permissions/${permissions[0].id}`, "POST", { optionId: "once" })).status).toBe(404)
        expect(JSON.stringify(await (await active.request("/session/saved/message")).json())).toContain("Persisted recovery-peer answer.")
        await (await active.request("/session/saved/message", "POST", { parts: [{ type: "text", text: "Continue explicitly." }] })).text()
        const log = (await readFile(logFile, "utf8")).trim().split("\n").map(line => JSON.parse(line))
        expect(log.filter(row => row.method === "session/new")).toHaveLength(1)
        expect(log.filter(row => row.method === "session/prompt")).toHaveLength(2)
        expect(log.filter(row => row.method === "session/resume")).toHaveLength(1)
        expect(log.some(row => row.id === "approval-rpc" && row.result?.outcome?.outcome === "selected")).toBe(false)
        return
      }
      expect((await active.request("/session/saved/message", "POST", { parts: [{ type: "text", text: "Remember the original conversation." }] })).status).toBe(200)
      const before = await (await active.request("/session/saved/message")).json()
      expect(JSON.stringify(before)).toContain("Persisted recovery-peer answer.")
      await active.host.dispose()
      active = await open()
      expect(await (await active.request("/session/saved/message")).json()).toEqual(before)
      const next = await active.request("/session/saved/message", "POST", { parts: [{ type: "text", text: "Continue explicitly." }] })
      // The HTTP streaming route can accept a turn whose failure is recorded in
      // history; the wire log proves whether execution or replacement occurred.
      await next.text()
      const log = (await readFile(logFile, "utf8")).trim().split("\n").map(line => JSON.parse(line))
      const creations = log.filter(row => row.method === "session/new")
      const prompts = log.filter(row => row.method === "session/prompt")
      expect(creations).toHaveLength(recovery === "missing" ? 2 : 1)
      expect(prompts).toHaveLength(recovery === "auth" || recovery === "unsupported" ? 1 : 2)
      const after = JSON.stringify(await (await active.request("/session/saved/message")).json())
      expect(after).toContain("Persisted recovery-peer answer.")
      if (recovery === "missing") {
        expect(after).toContain("Cache busted — agent context rebuilt from saved conversation")
        expect(JSON.stringify(prompts[1].params.prompt)).toContain("Remember the original conversation.")
        expect(prompts[1].params.sessionId).not.toBe(prompts[0].params.sessionId)
      } else {
        expect(after).not.toContain("Cache busted")
        if (recovery === "resume") expect(prompts[1].params.sessionId).toBe(prompts[0].params.sessionId)
      }
      expect(new Set(log.map(row => row.pid)).size).toBe(2)
    } finally { await active.host.dispose(); await rm(directory, { recursive: true, force: true }) }
  })
}
