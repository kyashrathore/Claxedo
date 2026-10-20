/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { surfaceReplySpec, surfaceReplySpecInput } from "./surface-reply-spec"

const components = [{ id: "root", component: "Text" as const, text: "Ready" }]

describe("surfaceReplySpecInput", () => {
  test("keeps only the spec's fields from a part input the runtime annotated for display", () => {
    const input = { intent: "mcp", kind: "dynamic_tool_call", title: "Status", components, data: { ok: true } }
    expect(surfaceReplySpec(surfaceReplySpecInput(input))).toEqual({ title: "Status", components, data: { ok: true } })
  })

  test("reads the arguments Codex nests as a JSON string", () => {
    const input = { server: "claxedo", tool: "ui_show", arguments: JSON.stringify({ title: "Status", components }) }
    expect(surfaceReplySpec(surfaceReplySpecInput(input))).toEqual({ title: "Status", components })
  })

  test("checks an agent's reply as the agent producer: a plugin-only component or event draws nothing", () => {
    const picker = [{ id: "root", component: "AgentConfigurationPicker", placement: "local", value: { path: "/primary" } }]
    expect(surfaceReplySpec({ title: "Preset", components: picker, data: { primary: { harness: null, model: null, effort: null } } })).toBeUndefined()
    const board = (move: Record<string, unknown>) => [
      { id: "root", component: "Board", columns: [{ key: "todo", title: "To do", items: "/todo" }], item: "card", itemKey: "id", ...move },
      { id: "card", component: "Text", text: { path: "title" } },
    ]
    expect(surfaceReplySpec({ title: "Board", components: board({ move: { event: { name: "moveCard" } } }), data: { todo: [] } })).toBeUndefined()
    expect(surfaceReplySpec({ title: "Board", components: board({}), data: { todo: [] } })).toMatchObject({ title: "Board" })
  })

  test("is absent for an input that is not a valid spec", () => {
    expect(surfaceReplySpec(surfaceReplySpecInput({ title: "Status", components: [{ id: "top", component: "Text", text: "x" }] }))).toBeUndefined()
  })
})
