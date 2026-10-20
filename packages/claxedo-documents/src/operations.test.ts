import { describe, expect, test } from "bun:test"
import { hostedOperationTable } from "@claxedo/account-contract"
import { MissingOperationParameter } from "@claxedo/account-contract/operation-definition"
import { DOCUMENTS_OPERATIONS } from "./operations"

const table = hostedOperationTable(DOCUMENTS_OPERATIONS)

describe("DOCUMENTS_OPERATIONS", () => {
  test("composes after the core table without taking a core name", () => {
    const composed: string[] = table.names().filter((name) => name.startsWith("documents."))
    expect(composed).toEqual(Object.keys(DOCUMENTS_OPERATIONS))
    expect(hostedOperationTable().names().filter((name) => name.startsWith("documents."))).toEqual([])
  })

  test("reaches only the documents routes, at a fixed method, with no caller-selected query", () => {
    for (const [name, operation] of Object.entries(DOCUMENTS_OPERATIONS)) {
      expect({ name, pattern: operation.path.pattern?.startsWith("/documents") }).toEqual({ name, pattern: true })
      expect({ name, method: typeof operation.method }).toEqual({ name, method: "string" })
      expect({ name, substituted: /:[A-Za-z]/.test(operation.path.pattern?.split("?")[1] ?? "") }).toEqual({ name, substituted: false })
    }
  })

  test("content saves and snapshot restores require the version token", () => {
    expect(() => table.resolve("documents.content.put", { id: "d", markdown: "# Hi" })).toThrow(MissingOperationParameter)
    expect(() => table.resolve("documents.snapshots.restore", { id: "d", snapshotId: "s" })).toThrow(MissingOperationParameter)
    expect(table.resolve("documents.content.put", { id: "d", markdown: "# Hi", ifMatch: "v1" })).toEqual({
      method: "PUT",
      path: "/documents/d/content",
      body: { markdown: "# Hi" },
      headers: { "If-Match": "v1" },
    })
  })

  test("an export answers bytes, which only the desktop bridge can carry", () => {
    expect(table.resolve("documents.export", { id: "doc/1" })).toEqual({ method: "GET", path: "/documents/doc%2F1/export", response: "bytes" })
    expect(DOCUMENTS_OPERATIONS["documents.export"].exposure).toEqual({ renderer: true, app: false })
    expect(Object.entries(DOCUMENTS_OPERATIONS).filter(([, operation]) => operation.response === "bytes").map(([name]) => name)).toEqual(["documents.export"])
  })
})
