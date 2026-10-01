import { afterAll, expect, mock, spyOn, test } from "bun:test"
import type { Stack } from "./stack"

const originals = [
  ["./stack", { ...await import("./stack") }],
  ["./tls-front", { ...await import("./tls-front") }],
  ["./relay", { ...await import("./relay") }],
  ["../../../harness/e2e/harness/scripted-providers", { ...await import("../../../harness/e2e/harness/scripted-providers") }],
  ["../../../harness/e2e/harness/ports", { ...await import("../../../harness/e2e/harness/ports") }],
] as const
afterAll(() => { for (const [name, module] of originals) mock.module(name, () => module) })
const closed: string[] = []
mock.module("./stack", () => ({
  startStack: async () => ({
    url: "http://127.0.0.1:42000", dataDir: "/test/state",
    daemon: { restart: async () => {} }, close: async () => { closed.push("stack") },
  } as unknown as Stack),
}))
mock.module("./tls-front", () => ({ startTlsFront: async () => ({ url: "https://127.0.0.1:42001", trust: {}, close: async () => { closed.push("front") } }) }))
mock.module("./relay", () => ({ relayResolverToken: () => "test-resolver", startRelay: async () => ({ log: () => "", close: async () => { closed.push("relay") } }) }))
mock.module("../../../harness/e2e/harness/ports", () => ({ reservePort: async () => 42002, releasePort: () => {} }))
mock.module("../../../harness/e2e/harness/scripted-providers", () => ({ storeScriptedKeys: async () => {} }))
const { startSignedStack } = await import("./signed-stack")

test("closing the signed cloud stack stops workerd before removing its persistent directory", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ user: { id: "test-owner" } }, { headers: { "set-auth-token": "test-token" } }))
  try {
    const stack = await startSignedStack({ label: "lifecycle", frontPort: 42001, distDir: "/test/app", cloud: true })
    await stack.close()
    expect(closed).toEqual(["front", "relay", "stack"])
  } finally {
    fetch.mockRestore()
  }
})
