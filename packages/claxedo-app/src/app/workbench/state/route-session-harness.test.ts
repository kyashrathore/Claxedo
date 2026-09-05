import { describe, expect, test } from "bun:test"
import { routeSessionHarness } from "./route-session-harness"

describe("route session harness", () => {
  test("reads canonical selections and runtime identities without inferring a provider", () => {
    const connection = { kind: "connection", connectionId: "team-agent" } as const
    expect(routeSessionHarness({ config: { harness: connection } })).toEqual(connection)
    expect(routeSessionHarness({ harness: { id: "team-agent", access: "connection" } })).toEqual(connection)
    expect(routeSessionHarness({ harness: { id: "claude", access: "native" } }))
      .toEqual({ kind: "native", harnessId: "claude" })
  })

  test("rejects incomplete identities and removed builtin engines", () => {
    expect(routeSessionHarness({ config: { harness: { type: "opencode" } } })).toBeUndefined()
    expect(routeSessionHarness({ harness: { id: "opencode", access: "native" } })).toBeUndefined()
    expect(routeSessionHarness({ harness: { id: "claude" } })).toBeUndefined()
  })

  test("does not infer harness identity from unrelated durable tags", () => {
    expect(routeSessionHarness({ host: "central", tags: ["source-channel:telegram", "harness:pi"] })).toBeUndefined()
  })
})
