import { describe, expect, test } from "vitest"
import { localOptionalFeatures, localOptionalProxyRoutes } from "./optional-features"

describe("local optional features", () => {
  test("defaults both expensive feature graphs off and opts in only with exact 1 values", () => {
    expect(localOptionalFeatures({})).toEqual({ documents: false, workgraph: false })
    expect(localOptionalFeatures({ CLAXEDO_ENABLE_DOCUMENTS: "true", CLAXEDO_ENABLE_WORKGRAPH: "0" })).toEqual({
      documents: false,
      workgraph: false,
    })
    expect(localOptionalFeatures({ CLAXEDO_ENABLE_DOCUMENTS: "1", CLAXEDO_ENABLE_WORKGRAPH: "1" })).toEqual({
      documents: true,
      workgraph: true,
    })
  })

  test("mounts no local Documents route when Documents is disabled", () => {
    expect(localOptionalProxyRoutes({ documents: false, workgraph: false })).toEqual([])
  })

  test("mounts lazy Documents route proxies when Documents is enabled", () => {
    const mounted = localOptionalProxyRoutes({ documents: true, workgraph: false })
    expect(mounted).toContain("/documents")
    expect(mounted).toContain("/documents/*")
    expect(mounted).toContain("/internal/documents")
  })
})
