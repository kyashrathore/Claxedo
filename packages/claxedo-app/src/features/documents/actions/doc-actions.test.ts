import { beforeEach, describe, expect, test } from "bun:test"
import { configureAppPortsForTest } from "@/app/integrations/test-support/app-ports-stub"
import { turnDocumentIntoWork } from "./doc-actions"

describe("document WorkGraph actions", () => {
  beforeEach(() => configureAppPortsForTest())

  test("dispatches only the canonical document identity and placement", async () => {
    const request = {
      projectId: "project_1",
      documentId: "document_1",
      placement: "local" as const,
      targetStreamId: "stream_1",
    }
    const calls: unknown[] = []
    configureAppPortsForTest({
      documents: {
        turnDocumentIntoWork: async (input) => {
          calls.push(input)
          return {
            proposalId: "proposal_1",
            source: { workSourceId: "source_1", revisionId: "source_revision_1", contentHash: "a".repeat(64) },
            targetStreamId: input.targetStreamId,
          }
        },
      },
    })

    await expect(turnDocumentIntoWork(request)).resolves.toMatchObject({ proposalId: "proposal_1" })
    expect(calls).toEqual([request])
  })

  test("rejects incomplete identity before invoking the app port", () => {
    let calls = 0
    configureAppPortsForTest({
      documents: {
        turnDocumentIntoWork: async () => {
          calls++
          throw new Error("must not run")
        },
      },
    })

    expect(() => turnDocumentIntoWork({ projectId: "project_1", documentId: "", placement: "local" })).toThrow()
    expect(calls).toBe(0)
  })
})
