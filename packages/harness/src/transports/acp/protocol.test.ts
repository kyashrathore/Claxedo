import { describe, expect, test } from "bun:test"
import { acpGrantKey, acpPrompt } from "./protocol"
import type { ToolCallUpdate } from "@agentclientprotocol/sdk"
import type { TurnInput } from "../../contract"

test("ACP delivers URL references using its mandatory resource-link block", async () => {
  const uri = "https://attachments.invalid/remote.png"
  const turn = { prompt: { parts: [{ type: "file", mime: "image/png", filename: "remote.png", url: uri }] } } as TurnInput
  for (const capabilities of [undefined, {}, { image: true, embeddedContext: true }]) {
    expect(await acpPrompt(turn, { capabilities })).toEqual([{ type: "resource_link", uri, name: uri }])
  }
})

describe("ACP grant identity", () => {
  const call = (input: Partial<ToolCallUpdate>): ToolCallUpdate => ({ toolCallId: "call", title: "Run command", kind: "execute",
    rawInput: { command: "npm test", description: "Runs the tests" }, ...input })

  test("a grant is a digest of the tool's kind and its input, never its display title", () => {
    const key = acpGrantKey(call({}))
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(key).not.toContain("npm test")
    expect(key).toBe(acpGrantKey(call({ toolCallId: "another", title: "Run the test suite" })))
    expect(key).not.toBe(acpGrantKey(call({ rawInput: { command: "rm -rf build", description: "Runs the tests" } })))
    expect(key).not.toBe(acpGrantKey(call({ kind: "edit" })))
  })

  test("an absent kind is other, never a wildcard", () => {
    expect(acpGrantKey(call({ kind: undefined }))).not.toBe(acpGrantKey(call({})))
    expect(acpGrantKey(call({ kind: undefined }))).toBe(acpGrantKey(call({ kind: "other" })))
  })

  test("the locations a call names are part of its identity", () => {
    const edit = call({ kind: "edit", rawInput: { content: "x" }, locations: [{ path: "/repo/a.ts" }] })
    expect(acpGrantKey(edit)).not.toBe(acpGrantKey({ ...edit, locations: [{ path: "/repo/b.ts" }] }))
  })

  test("a request with no input and no locations cannot acquire a grant", () => {
    expect(acpGrantKey(call({ rawInput: undefined }))).toBeUndefined()
  })
})
