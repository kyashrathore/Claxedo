import { describe, expect, test } from "bun:test"
import { durableDocumentRevisionForPage, TURN_REVISION_INTO_WORK_LABEL } from "./doc-work-action"

const boundFields = {
  project_id: "project_1",
  document_id: "document_1",
  document_revision_id: "revision_1",
}

describe("durableDocumentRevisionForPage", () => {
  test("returns the exact persisted revision locator when the page is Docs v2 bound", () => {
    expect(durableDocumentRevisionForPage(boundFields)).toEqual({
      projectId: "project_1",
      documentId: "document_1",
      revisionId: "revision_1",
    })
  })

  test("trims persisted identifiers", () => {
    expect(
      durableDocumentRevisionForPage({
        project_id: "  project_1  ",
        document_id: " document_1 ",
        document_revision_id: " revision_1 ",
      }),
    ).toEqual({ projectId: "project_1", documentId: "document_1", revisionId: "revision_1" })
  })

  test("is honestly unavailable (undefined) when the durable revision id is missing", () => {
    expect(durableDocumentRevisionForPage({ ...boundFields, document_revision_id: null })).toBeUndefined()
    expect(durableDocumentRevisionForPage({ ...boundFields, document_revision_id: "" })).toBeUndefined()
    expect(durableDocumentRevisionForPage({ ...boundFields, document_revision_id: "   " })).toBeUndefined()
  })

  test("is honestly unavailable when the document id is missing", () => {
    expect(durableDocumentRevisionForPage({ ...boundFields, document_id: undefined })).toBeUndefined()
  })

  test("is honestly unavailable when the project id is missing", () => {
    expect(durableDocumentRevisionForPage({ ...boundFields, project_id: null })).toBeUndefined()
  })

  test("exposes a stable accessible name", () => {
    expect(TURN_REVISION_INTO_WORK_LABEL).toBe("Turn current revision into WorkGraph work")
  })
})
