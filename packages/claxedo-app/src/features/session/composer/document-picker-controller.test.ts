import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createDocumentPickerController } from "./document-picker-controller"

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function harness(overrides: { sessionId?: () => string | undefined; promptText?: () => string } = {}) {
  let resolveOpen!: (value: unknown) => void
  const replacements: string[] = []
  const controller = createRoot(() => createDocumentPickerController({
    directory: () => "/repo",
    scope: () => "scope_1",
    sessionId: overrides.sessionId ?? (() => "session_1"),
    draftId: () => "draft_1",
    promptText: overrides.promptText ?? (() => "/docs"),
    list: async () => [{
      documentId: "document_1",
      displayName: "Notes",
      originKind: "managed",
      placementKind: "local",
      status: "draft",
    }],
    openDocument: () => new Promise((resolve) => {
      resolveOpen = resolve
    }),
    mentionText: () => "document: Notes at .claxedo/docs/document_1/notes.md",
    replaceText: (text) => replacements.push(text),
    openPopover: () => undefined,
  }))
  return { controller, replacements, resolve: (value: unknown) => resolveOpen(value) }
}

describe("document picker controller", () => {
  test("replaces only the unchanged initiating draft", async () => {
    const state = { prompt: "/docs" }
    const value = harness({ promptText: () => state.prompt })
    value.controller.show()
    value.controller.select({ type: "document", documentId: "document_1", display: "Notes", originKind: "managed", placementKind: "local", status: "draft" })
    state.prompt = "newer typing"
    value.resolve({})
    await tick()
    expect(value.replacements).toEqual([])
  })

  test("inserts the mention and closes for the current draft", async () => {
    const value = harness()
    value.controller.show()
    value.controller.select({ type: "document", documentId: "document_1", display: "Notes", originKind: "managed", placementKind: "local", status: "draft" })
    value.resolve({})
    await tick()
    expect(value.replacements).toEqual(["document: Notes at .claxedo/docs/document_1/notes.md"])
    expect(value.controller.open()).toBe(false)
  })

  test("fails closed before a session exists", () => {
    const value = harness({ sessionId: () => "new" })
    value.controller.show()
    value.controller.select({ type: "document", documentId: "document_1", display: "Notes", originKind: "managed", placementKind: "local", status: "draft" })
    expect(value.controller.notice()).toContain("start the session")
    expect(value.controller.open()).toBe(false)
  })
})
