import { describe, expect, test } from "bun:test"
import { hostedOperationRequest } from "./operations"

describe("hosted operations over the connected server's routes", () => {
  test("a list reads the documents route with its scope", () => {
    expect(hostedOperationRequest("documents.list", { project_id: "p1", archived: "all" })).toEqual({
      method: "GET",
      path: "/documents",
      query: { project_id: "p1", document_id: undefined, directory: undefined, archived: "all" },
    })
  })

  test("a content save sends the version it read as If-Match", () => {
    expect(hostedOperationRequest("documents.content.put", { id: "doc 1", ifMatch: "v3", display_name: "Notes", markdown: "# Hi" })).toEqual({
      method: "PUT",
      path: "/documents/doc%201/content",
      body: { display_name: "Notes", markdown: "# Hi" },
      ifMatch: "v3",
    })
  })

  test("a restore names the snapshot in the path", () => {
    expect(hostedOperationRequest("documents.snapshots.restore", { id: "d", snapshotId: "s", ifMatch: "v1" })).toMatchObject({
      method: "POST",
      path: "/documents/d/snapshots/s/restore",
      ifMatch: "v1",
    })
  })

  test("an unknown operation, a missing id or a non-object input is refused as invalid", () => {
    for (const [name, input] of [
      ["tasks.list", {}],
      ["documents.get", {}],
      ["documents.content.put", { id: "d" }],
      ["documents.list", ["p1"]],
    ] as const) {
      expect(() => hostedOperationRequest(name, input)).toThrow(expect.objectContaining({ class: "invalid" }))
    }
  })
})
