import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createDocumentPickerController } from "./document-picker-controller"

function harness(list?: Parameters<typeof createDocumentPickerController>[0]["list"]) {
  const replacements: string[] = []
  const controller = createRoot(() => createDocumentPickerController({
    directory: () => "/repo",
    list: list ?? (async () => [{
      documentId: "document_1",
      displayName: "Notes",
      originKind: "managed",
      placementKind: "local",
      status: "draft",
    }]),
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
    expect(value.controller.notice()).toBeUndefined()
  })

  test("an older listing cannot replace the latest opened document list", async () => {
    type Documents = Awaited<ReturnType<Parameters<typeof createDocumentPickerController>[0]["list"]>>
    const releases: Array<(documents: Documents) => void> = []
    const value = harness(() => new Promise<Documents>((resolve) => releases.push(resolve)))
    value.controller.show()
    value.controller.show()
    expect(releases).toHaveLength(2)
    expect(value.controller.notice()).toBe("Loading documents…")

    const latest: Documents = [{ documentId: "new", displayName: "Latest", originKind: "managed", placementKind: "local", status: "draft" }]
    releases[1](latest)
    await Promise.resolve()
    expect(value.controller.documents()).toEqual(latest)
    expect(value.controller.notice()).toBeUndefined()

    releases[0]([{ ...latest[0], documentId: "old", displayName: "Stale" }])
    await Promise.resolve()
    expect(value.controller.documents()).toEqual(latest)
  })
})
