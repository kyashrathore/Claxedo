import { describe, expect, test } from "vitest"
import { normalizeRuntimeSnapshot } from "@claxedo/workspace-runtime/config"
import { imageSmokeRuntimeSnapshot } from "../workspace-runtime-image-smoke-snapshot"

describe("workspace-runtime image smoke snapshot", () => {
  test("the runtime's config route accepts the smoke's push unchanged", () => {
    const snapshot = imageSmokeRuntimeSnapshot("http://127.0.0.1:4100")
    expect(normalizeRuntimeSnapshot(JSON.parse(JSON.stringify(snapshot)), {})).toEqual(snapshot)
  })
})
