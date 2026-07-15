import { describe, expect, test } from "bun:test"
import path from "node:path"
import { walkProdSources, workGraphEagerSurfaceViolations } from "./scanners"

const appRoot = path.resolve(import.meta.dir, "../..")

describe("WorkGraph eager surface guard", () => {
  test("keeps WorkGraph immediately available when its tab opens", () => {
    expect(workGraphEagerSurfaceViolations(walkProdSources(appRoot))).toEqual([])
  })

  test("flags a lazy WorkGraph surface and its visible loading fallback", () => {
    expect(workGraphEagerSurfaceViolations([{
      path: "app/integrations/first-party-content-surfaces.tsx",
      text: 'const WorkGraphContent = lazy(() => import("../../features/workgraph"))\nLoading WorkGraph',
    }]).map((finding) => finding.match)).toEqual([
      "WorkGraphContent must be imported eagerly",
      "const WorkGraphContent = lazy",
      "Loading WorkGraph",
    ])
  })
})
