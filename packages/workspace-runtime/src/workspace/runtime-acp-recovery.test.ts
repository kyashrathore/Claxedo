import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Hono } from "hono"
import { createWorkspaceHost } from "./runtime"
import { loopbackWorkspaceRuntimeExposure } from "../exposure"
import { withWorkspaceTarget } from "../target"
import { loopbackMachineLoginPolicy } from "../testing"

for (const recovery of ["resume", "missing", "auth", "unsupported", "approval", "cancel"]) {
  test(`public ACP history survives runtime restart; restoration outcome ${recovery}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "workspace-acp-recovery-"))
    const target = { workspaceId: "recovery-workspace", directory }
    const logFile = join(directory, "peer.jsonl")
    const peer = fileURLToPath(new URL("./fixtures/acp-recovery-peer.mjs", import.meta.url))
    const config = { version: 4 as const, commands: [], auth: { machineOwnerUserId: "local", accounts: { local: {} } }, mcp: {}, connections: [{ connectionId: "recovery", providerKey: "acp", configRevision: 1, enabled: true, config: { label: "Recovery peer", connection: { kind: "process", command: "node", args: [peer, logFile, recovery] } } }], defaultHarness: { kind: "connection" as const, connectionId: "recovery" } }
    const sessionErrors: string[] = []
    const open = async () => {
      const host = createWorkspaceHost({ sessionIdWorkspace: () => undefined, placement: loopbackMachineLoginPolicy(), target, storeRoot: join(directory, "store"),
        onPresentationEvent: ({ payload }) => { if (payload.type === "session.error") sessionErrors.push(JSON.stringify(payload.properties)) } })
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

        // The peer takes the cancel notification but holds its prompt open, so
        // this answers only once the ACP transport's 5 s cancel deadline passes.
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
        const operation: Record<string, any> = outcome.operation
        // The prompt is still open, so the operation does not succeed and the
        // turn reads as still running. A "cancelled" answer here would be the
        // exact lie this contract exists to prevent.
        expect(operation.state).not.toBe("succeeded")
        expect(operation.facts.execution.value).toBe("running")
        expect(operation.initiatingError).toMatchObject({ code: "cancellation_timeout", executionMayContinue: true })
        expect(operation.action).toBe("cancel_turn")

        // The same operation is readable by its receipt, with the same facts.
        const reread = await (await active.request(`/session/saved/recovery/operations/${operation.operationId}`)).json()
        expect(reread.operation.facts.execution.value).toBe("running")

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
        const prompts = log.filter(row => row.method === "session/prompt")
        expect(prompts).toHaveLength(3)
        const pidOf = (text: string) => prompts.find(row => JSON.stringify(row.params).includes(text))?.pid
        // Each session runs its own agent. The stopped one keeps its agent while
        // its cancellation is unresolved: the cancel reaches the agent that holds
        // the prompt, and only the turn that follows the settlement attaches a
        // fresh one.
        expect(log.find(row => row.method === "session/cancel")?.pid).toBe(pidOf("Wait for cancellation."))
        expect(pidOf("Continue after settlement.")).not.toBe(pidOf("Wait for cancellation."))
        expect(pidOf("Independent sibling.")).not.toBe(pidOf("Wait for cancellation."))
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
        await writeFile(logFile + ".restarted", "restarted")
        await (await waiting).text()
        active = await open()
        expect(await (await active.request("/permission")).json()).toEqual([])
        expect((await active.request(`/session/saved/permissions/${permissions[0].id}`, "POST", { optionId: "once" })).status).toBe(404)
        expect(JSON.stringify(await (await active.request("/session/saved/message")).json())).toContain("Persisted recovery-peer answer.")
        await (await active.request("/session/saved/message", "POST", { parts: [{ type: "text", text: "Continue explicitly." }] })).text()
        const log = (await readFile(logFile, "utf8")).trim().split("\n").map(line => JSON.parse(line))
        expect(log.filter(row => row.method === "session/new")).toHaveLength(1)
        expect(log.filter(row => row.method === "session/prompt")).toHaveLength(2)
        // One resume attaches the idle session for its first turn; the restart's is the second.
        expect(log.filter(row => row.method === "session/resume")).toHaveLength(2)
        expect(log.some(row => row.id === "approval-rpc" && row.result?.outcome?.outcome === "selected")).toBe(false)
        return
      }
      expect((await active.request("/session/saved/message", "POST", { parts: [{ type: "text", text: "Remember the original conversation." }] })).status).toBe(200)
      const before = await (await active.request("/session/saved/message")).json()
      expect(JSON.stringify(before)).toContain("Persisted recovery-peer answer.")
      await active.host.dispose()
      await writeFile(logFile + ".restarted", "restarted")
      active = await open()
      expect(await (await active.request("/session/saved/message")).json()).toEqual(before)
      const route = recovery === "missing" ? "prompt_async" : "message"
      const next = await active.request(`/session/saved/${route}`, "POST", { parts: [{ type: "text", text: "Continue explicitly." }] })
      // The HTTP streaming route can accept a turn whose failure is recorded in
      // history; the wire log proves whether execution or replacement occurred.
      await next.text()
      if (recovery === "missing") {
        expect(next.status).toBe(204)
        for (let n = 0; n < 200 && !sessionErrors.length; n++) await Bun.sleep(5)
        expect(sessionErrors).toHaveLength(1)
        expect(sessionErrors[0]).toContain("ACP agent no longer has session")
      }
      const log = (await readFile(logFile, "utf8")).trim().split("\n").map(line => JSON.parse(line))
      const creations = log.filter(row => row.method === "session/new")
      const prompts = log.filter(row => row.method === "session/prompt")
      expect(creations).toHaveLength(1)
      expect(prompts).toHaveLength(recovery === "resume" ? 2 : 1)
      const after = JSON.stringify(await (await active.request("/session/saved/message")).json())
      expect(after).toContain("Persisted recovery-peer answer.")
      if (recovery === "resume") expect(prompts[1].params.sessionId).toBe(prompts[0].params.sessionId)
      // The idle session is released after its creation and after its turn, so
      // its creation, its first turn and the restart's turn each ran their own
      // agent; an agent that cannot resume keeps the one it started with.
      expect(new Set(log.map(row => row.pid)).size).toBe(recovery === "unsupported" ? 2 : 3)
    } finally { await active.host.dispose(); await rm(directory, { recursive: true, force: true }) }
  }, recovery === "cancel" ? 15_000 : undefined)
}
