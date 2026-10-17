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

  test("is absent for an input that is not a valid spec", () => {
    expect(surfaceReplySpec(surfaceReplySpecInput({ title: "Status", components: [{ id: "top", component: "Text", text: "x" }] }))).toBeUndefined()
  })
})
