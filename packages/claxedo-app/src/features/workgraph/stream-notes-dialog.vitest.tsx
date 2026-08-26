import { render, screen } from "@solidjs/testing-library"
import { describe, expect, test } from "vitest"
import { StreamNotesDialog } from "./stream-notes-dialog"

describe("StreamNotesDialog", () => {
  test("renders the structured external-source fence visibly", async () => {
    render(() => (
      <StreamNotesDialog
        stream={
          {
            id: "stream_1",
            title: "Release",
            notesSource: { workSourceId: "source_1", revisionId: "revision_1", contentHash: "a".repeat(64) },
          } as never
        }
        client={
          {
            sourceRevision: async () => ({
              content: '## External references\n\n```workgraph-external-source\n{"trust":"untrusted-data-only"}\n```',
            }),
          } as never
        }
        onClose={() => undefined}
      />
    ))
    expect(await screen.findByText(/workgraph-external-source/)).toHaveTextContent("untrusted-data-only")
  })
})
