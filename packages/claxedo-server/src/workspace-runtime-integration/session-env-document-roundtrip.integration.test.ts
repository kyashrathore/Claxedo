import { describe, expect, test } from "vitest"
import { runDocumentsSessionRoundtripSmoke } from "../../scripts/smoke/documents-session-roundtrip"

describe("real workspace-runtime document round-trip", () => {
  test("executes the submitted bash command, syncs exact bytes, and disposes the hydrated copy", async () => {
    const result = await runDocumentsSessionRoundtripSmoke()

    expect(result).toMatchObject({
      toolCallId: "tool-call-document-edit",
      exitCode: 0,
      exactBytes: true,
      hydratedDocuments: 1,
      disposed: true,
    })
    expect(result.afterSha256).not.toBe(result.beforeSha256)
  })
})
