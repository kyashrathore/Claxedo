import { beforeEach, describe, expect, test } from "bun:test"
import { configureAppPortsForTest } from "@/app/integrations/test-support/app-ports-stub"
import { turnDocumentRevisionIntoWork } from "./doc-actions"

describe("Docs v2 actions", () => {
  beforeEach(() => configureAppPortsForTest())

  test("dispatches only the exact revision locator through the app-owned integration port", async () => {
    const locator = {
      projectId: "project_1",
      documentId: "document_1",
      revisionId: "revision_1",
      targetStreamId: "stream_1",
    }
    const calls: unknown[] = []
    configureAppPortsForTest({
      documents: {
        turnDocumentRevisionIntoWork: async (input) => {
          calls.push(input)
          return {
            proposalId: "proposal_1",
            source: { workSourceId: "source_1", revisionId: "source_revision_1", contentHash: "a".repeat(64) },
            targetStreamId: input.targetStreamId,
          }
        },
      },
    })

    await expect(turnDocumentRevisionIntoWork(locator)).resolves.toMatchObject({ proposalId: "proposal_1" })
    expect(calls).toEqual([locator])
  })

  test("rejects an incomplete durable revision locator before invoking the app port", async () => {
    let calls = 0
    configureAppPortsForTest({
      documents: {
        turnDocumentRevisionIntoWork: async () => {
          calls++
          throw new Error("must not run")
        },
      },
    })

    expect(() => turnDocumentRevisionIntoWork({
      projectId: "project_1",
      documentId: "document_1",
      revisionId: "",
    })).toThrow()
    expect(calls).toBe(0)
  })
})
