import { expect, test } from "bun:test"
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { AsyncPushQueue } from "@claxedo/helpers"
import { ClaudeLiveQuery } from "./live-query"
import { until } from "./test-support/live"

test("permission changes wait for launch and acknowledgement, serialize, and recover after refusal", async () => {
  const frames = new AsyncPushQueue<SDKMessage>()
  const current = { model: "sonnet", permissionMode: "default" }
  const live = new ClaudeLiveQuery("key", { unclaimed() {}, stage: () => async () => {}, background() {} }, current)
  const acknowledged = Promise.withResolvers<void>()
  const refused = new Error("mode refused")
  const calls: string[] = []
  const stream = { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](),
    async setPermissionMode(mode: string) {
      calls.push(mode)
      if (mode === "bypassPermissions") await acknowledged.promise
      if (mode === "plan") throw refused
    } } as unknown as Query
  const first = live.setPermissionMode("bypassPermissions")
  const second = live.setPermissionMode("plan").then(() => undefined, (error: unknown) => error)
  expect(calls).toEqual([])
  live.run(stream)
  await until(() => calls.length === 1)
  expect(current.permissionMode).toBe("default")
  acknowledged.resolve()
  await first
  expect(await second).toMatchObject({ code: "configuration", cause: refused })
  expect(current.permissionMode).toBe("bypassPermissions")
  await live.setPermissionMode("default")
  expect(current.permissionMode).toBe("default")
  expect(calls).toEqual(["bypassPermissions", "plan", "default"])
  frames.end()
  await live.ended
})

test("a native mode move updates the live snapshot so the same former selection is reapplied", async () => {
  const frames = new AsyncPushQueue<SDKMessage>()
  const current = { model: "sonnet", permissionMode: "default" }
  const live = new ClaudeLiveQuery("key", { unclaimed() {}, stage: () => async () => {}, background() {} }, current)
  const calls: string[] = []
  live.run({ [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](),
    async setPermissionMode(mode: string) { calls.push(mode) } } as unknown as Query)
  frames.push({ type: "system", subtype: "status", status: null, permissionMode: "plan", uuid: crypto.randomUUID(), session_id: "up1" })
  await until(() => current.permissionMode === "plan")
  await live.setPermissionMode("default")
  expect(calls).toEqual(["default"])
  expect(current.permissionMode).toBe("default")
  frames.end()
  await live.ended
})
