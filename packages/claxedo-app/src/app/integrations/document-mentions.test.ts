import { describe, expect, mock, test } from "bun:test"
import { documentMentionText, listDocumentMentions } from "./document-mentions"

const list = mock(async () => [
  {
    id: "doc-1",
    display_name: "Plan",
    project_id: "p1",
    origin_kind: "managed",
    placement_kind: "local",
    status: "draft",
    archived_at: null,
  },
])
describe("document mention integration", () => {
  test("maps index metadata into picker options and formats a compact semantic reference", async () => {
    const documents = await listDocumentMentions({ directory: "/repo" }, { list })
    expect(documents).toEqual([
      {
        documentId: "doc-1",
        displayName: "Plan",
        originKind: "managed",
        placementKind: "local",
        status: "draft",
      },
    ])
    expect(list).toHaveBeenCalledWith({ directory: "/repo" })
    expect(documentMentionText(documents[0]!)).toBe("claxedo://document/doc-1")
  })
})
