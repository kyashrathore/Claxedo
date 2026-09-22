import { expect, test } from "bun:test"
import { cancelPendingPermissions } from "./permission-reply"
import { ACPProcess } from "./process"
import { AcpHarnessAdapter } from "./index"
import { MemoryRuntimeStore } from "../../stores/memory"
import type { ACPTransportFactory } from "./transport"

class OwnerAdapter extends AcpHarnessAdapter {
  key(id: string, directory: string) { return this.keyForSession(id, directory) }
  entry(id: string) { return this.entryForSession(id) }
  invalidateKeys() { this.forgetSessionProcessBindings() }
  seed(key: string) { return this.process(key, "/work") }
}

test("invalidated session owner keys are not reused by read-only capability lookup", () => {
  const store = new MemoryRuntimeStore()
  store.bindSession({ sessionId: "session", directory: "/work", agentSessionId: "upstream", ownerKey: "retired" })
  const adapter = new OwnerAdapter({ harness: "test", store, connection: { kind: "process", command: "peer" } })
  const retired = adapter.seed("retired")
  expect(adapter.entry("session")).toBe(retired)
  adapter.invalidateKeys()
  expect(adapter.entry("session")).toBeUndefined()
  expect(adapter.readConnectionState("/work", { sessionId: "session" }).state).toBe("configured")
  expect(adapter.key("session", "/work")).not.toBe("retired")
  adapter.dispose()
})

for (const callback of ["onError", "onExit"] as const) test(`synchronous ${callback} preserves launch failure and retires its transport`, async () => {
  let disposals = 0, deaths = 0
  const factory: ACPTransportFactory = (input) => {
    if (callback === "onError") input.onError(new Error("original launch failure"))
    else input.onExit(17, null)
    return { kind: "stdio", metadata: {}, alive: false, dispose() { disposals++ }, stream: {
      readable: new ReadableStream(), writable: new WritableStream(),
    } }
  }
  const proc = new ACPProcess("/work", "peer", [], "", () => [], () => { deaths++; expect(proc).toBeDefined() }, factory, () => ({}))
  await expect(proc.initialize()).rejects.toThrow(callback === "onError" ? "original launch failure" : "17")
  await Promise.resolve()
  expect(deaths).toBe(1)
  expect(disposals).toBe(1)
  await proc.dispose()
})

test("cancelling an intermediate child settles only its descendant interactions", async () => {
  const proc = new ACPProcess("/work", "peer", [], "", () => [], () => {}, () => ({ kind: "stdio", metadata: {}, alive: true, dispose() {}, stream: {
    readable: new ReadableStream(), writable: new WritableStream(),
  } }), () => ({}))
  const parents = (proc as unknown as { childParents: Map<string, string> }).childParents
  parents.set("child", "root"); parents.set("grandchild", "child"); parents.set("sibling", "root")
  const cancelled: string[] = [], questions: string[] = []
  proc.elicitationCancel = id => { questions.push(id) }
  for (const aid of ["root", "child", "grandchild", "sibling"]) proc.pendingPermissions.set(aid, {
    aid, paths: [], options: [], resolve: () => { cancelled.push(aid) },
  })
  const owners = new Map([["grandchild", proc]])
  expect(() => cancelPendingPermissions({ owners, store: { appendEvent() { throw new Error("write failed") } } }, proc, "local", "child")).toThrow("write failed")
  expect(cancelled).toEqual([])
  expect(owners.get("grandchild")).toBe(proc)
  expect(proc.pendingPermissions.size).toBe(4)
  await proc.cancel("child")
  expect(cancelled).toEqual(["child", "grandchild"])
  expect(questions).toEqual(["child", "grandchild"])
  expect([...proc.pendingPermissions.keys()]).toEqual(["root", "sibling"])
  await proc.dispose()
})

test("a synchronous error followed by constructor failure does not schedule death callbacks", async () => {
  let deaths = 0
  expect(() => new ACPProcess("/work", "peer", [], "", () => [], () => { deaths++ }, (input) => {
    input.onError(new Error("callback failure"))
    throw new Error("factory failure")
  }, () => ({}))).toThrow("factory failure")
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(deaths).toBe(0)
})
