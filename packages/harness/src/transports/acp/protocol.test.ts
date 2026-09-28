import { describe, expect, test } from "bun:test"
import { acpElicitation, acpGrantKey, acpPermission, acpPrompt } from "./protocol"
import type { RequestAnswer, TurnBroker, TurnInput } from "../../contract"

test("ACP delivers URL references using its mandatory resource-link block", async () => {
  const uri = "https://attachments.invalid/remote.png"
  const turn = { prompt: { parts: [{ type: "file", mime: "image/png", filename: "remote.png", url: uri }] } } as TurnInput
  for (const capabilities of [undefined, {}, { image: true, embeddedContext: true }]) {
    expect(await acpPrompt(turn, { capabilities })).toEqual([{ type: "resource_link", uri, name: uri }])
  }
})

describe("ACP grant identity", () => {
  test("an absent kind is other, never a wildcard", () => {
    expect(acpGrantKey(undefined, "Read file")).toBe(JSON.stringify(["other", "Read file"]))
    expect(acpGrantKey(undefined, "Read file")).not.toBe(acpGrantKey("read", "Read file"))
  })

  test("an untitled request cannot acquire a grant", () => {
    expect(acpGrantKey("read", undefined)).toBeUndefined()
    expect(acpGrantKey("read", "")).toBeUndefined()
  })

  test("a grant matches only its kind and exact title", () => {
    const key = acpGrantKey("read", "Read file")
    expect(key).not.toBe(acpGrantKey("edit", "Read file"))
    expect(key).not.toBe(acpGrantKey("read", "Read File"))
  })
})

test("ACP tells the agent a rejected elicitation was declined and a withdrawn one was cancelled", async () => {
  const broker = (answer: RequestAnswer) => ({ ask: async () => answer }) as unknown as TurnBroker
  const request = { sessionId: "agent-session", mode: "form" as const, message: "Name", requestedSchema: { type: "object" as const, properties: {} } }
  expect(await acpElicitation(request, broker({ kind: "rejected" }))).toEqual({ action: "decline" })
  expect(await acpElicitation(request, broker({ kind: "cancelled" }))).toEqual({ action: "cancel" })
})

test("ACP permission asks carry the tool call's title, command and paths for the person deciding", async () => {
  const asked: unknown[] = []
  const broker = { ask: async (request: unknown) => { asked.push(request); return { kind: "cancelled" } } } as unknown as TurnBroker
  const toolCall = { toolCallId: "call-1", title: "Run once", kind: "execute" as const, rawInput: { command: "ls -la" }, locations: [{ path: "/work/a.txt" }] }
  await acpPermission({ sessionId: "agent-session", toolCall, options: [{ optionId: "allow-once", kind: "allow_once", name: "Allow" }], _meta: { trace: "t1" } }, broker, "s1")
  expect(asked).toMatchObject([{ permission: {
    permission: "execute", patterns: ["/work/a.txt"], always: ["/work/a.txt"],
    metadata: { title: "Run once", reason: "Run once", command: "ls -la", acpToolCall: toolCall, acpRequestMeta: { trace: "t1" } },
  } }])
})
