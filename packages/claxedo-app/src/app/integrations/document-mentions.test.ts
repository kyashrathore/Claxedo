import { describe, expect, mock, test } from "bun:test"
import { documentMentionText, listDocumentMentions, openDocumentMention } from "./document-mentions"

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
const agentOpen = mock(async () => ({
  document_id: "doc-1",
  display_name: "Plan",
  path: "/data/documents/p1/doc-1/plan.md",
}))

describe("document mention integration", () => {
  test("maps index metadata into picker options and resolves selection through agent-open", async () => {
    await expect(listDocumentMentions({ directory: "/repo" }, { list })).resolves.toEqual([
      {
        documentId: "doc-1",
        displayName: "Plan",
        originKind: "managed",
        placementKind: "local",
        status: "draft",
      },
    ])
    expect(list).toHaveBeenCalledWith({ directory: "/repo" })

    const opened = await openDocumentMention({ documentId: "doc-1", sessionId: "session-1" }, { agentOpen })
    expect(opened).toEqual({ documentId: "doc-1", displayName: "Plan", path: "/data/documents/p1/doc-1/plan.md" })
    expect(documentMentionText(opened)).toBe("document: Plan at /data/documents/p1/doc-1/plan.md (document_id: doc-1)")
  })
})
