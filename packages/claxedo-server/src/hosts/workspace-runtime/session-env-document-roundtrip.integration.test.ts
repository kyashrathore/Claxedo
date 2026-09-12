import { describe, expect, test } from "vitest"
import { runDocumentsSessionRoundtripSmoke } from "../../../scripts/smoke/documents-session-roundtrip"
import { unpinnedPiReason } from "../../../../agent-sdk-runtime/src/harnesses/pi/executable"

const unpinnedPi = unpinnedPiReason()

describe("real workspace-runtime document round-trip", () => {
  test.skipIf(unpinnedPi !== undefined)(
    "executes the submitted bash command, syncs exact bytes, and disposes the hydrated copy",
    async () => {
      const result = await runDocumentsSessionRoundtripSmoke()

      expect(result).toMatchObject({
        exitCode: 0,
        exactBytes: true,
        hydratedDocuments: 1,
        disposed: true,
      })
      expect(result.afterSha256).not.toBe(result.beforeSha256)
    },
  )
})
