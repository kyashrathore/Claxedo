import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createDocumentPickerController } from "./document-picker-controller"

function harness() {
  const replacements: string[] = []
  const controller = createRoot(() => createDocumentPickerController({
    directory: () => "/repo",
    list: async () => [{
      documentId: "document_1",
      displayName: "Notes",
      originKind: "managed",
      placementKind: "local",
      status: "draft",
    }],
    mentionText: (document) => `claxedo://document/${document.documentId}`,
    replaceText: (text) => replacements.push(text),
    openPopover: () => undefined,
  }))
  return { controller, replacements }
}

describe("document picker controller", () => {
  test("inserts a compact reference and closes immediately", () => {
    const value = harness()
    value.controller.show()
    value.controller.select({ type: "document", documentId: "document_1", display: "Notes", originKind: "managed", placementKind: "local", status: "draft" })
    expect(value.replacements).toEqual(["claxedo://document/document_1"])
    expect(value.controller.open()).toBe(false)
  })

  test("allows document selection before a session exists", () => {
    const value = harness()
    value.controller.show()
    value.controller.select({ type: "document", documentId: "document_1", display: "Notes", originKind: "managed", placementKind: "local", status: "draft" })
    expect(value.replacements).toEqual(["claxedo://document/document_1"])
    expect(value.controller.notice()).toBeUndefined()
  })
})
