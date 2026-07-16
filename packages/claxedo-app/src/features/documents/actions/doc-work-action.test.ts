import { describe, expect, test } from "bun:test"
import { TURN_DOCUMENT_INTO_WORK_LABEL, workSourceForDocument } from "./doc-work-action"

describe("workSourceForDocument", () => {
  test("returns canonical identity and placement without fabricating a snapshot", () => {
    expect(workSourceForDocument({ project_id: " project_1 ", id: " document_1 ", placement_kind: "local" })).toEqual({
      projectId: "project_1",
      documentId: "document_1",
      placement: "local",
    })
  })

  test("is honestly unavailable when identity is missing", () => {
    expect(workSourceForDocument({ project_id: "", id: "document_1", placement_kind: "local" })).toBeUndefined()
    expect(workSourceForDocument({ project_id: "project_1", id: "", placement_kind: "local" })).toBeUndefined()
  })

  test("carries target context and exposes one accessible label", () => {
    expect(
      workSourceForDocument(
        { project_id: "project_1", id: "document_1", placement_kind: "hosted" },
        { repositoryUrl: "https://git.example/repo.git" },
      ),
    ).toEqual({
      projectId: "project_1",
      documentId: "document_1",
      placement: "hosted",
      repositoryUrl: "https://git.example/repo.git",
    })
    expect(TURN_DOCUMENT_INTO_WORK_LABEL).toBe("Turn current document into WorkGraph work")
  })
})
