import { describe, expect, test } from "bun:test"
import path from "node:path"
import {
  LOCAL_SURFACE_FILE,
  WORKGRAPH_SURFACE_FILE,
  walkProdSources,
  workGraphEagerSurfaceViolations,
  workGraphNativePickerViolations,
} from "./scanners"

const appRoot = path.resolve(import.meta.dir, "../..")

describe("WorkGraph eager surface guard", () => {
  test("keeps WorkGraph immediately available when its tab opens", () => {
    expect(workGraphEagerSurfaceViolations(walkProdSources(appRoot))).toEqual([])
  })

  test("picks project folders with the in-app dialog, never the OS-native picker", () => {
    expect(workGraphNativePickerViolations(walkProdSources(appRoot))).toEqual([])
  })

  test("flags a reintroduced native directory picker on the WorkGraph surface", () => {
    expect(workGraphNativePickerViolations([{
      path: WORKGRAPH_SURFACE_FILE,
      text: "const result = await platform.openDirectoryPickerDialog({ multiple: false })",
    }]).map((finding) => finding.match)).toEqual(["openDirectoryPickerDialog"])
  })

  test("flags a lazy WorkGraph surface and its visible loading fallback", () => {
    // The hosted contribution set already loads as a unit. A second layer of
    // laziness around the renderer buys nothing and costs a spinner frame on
    // every tab open.
    expect(workGraphEagerSurfaceViolations([{
      path: WORKGRAPH_SURFACE_FILE,
      text: 'const WorkGraphContent = lazy(() => import("../../features/workgraph"))\nLoading WorkGraph',
    }]).map((finding) => finding.match)).toEqual([
      "WorkGraphContent must be imported eagerly",
      "const WorkGraphContent = lazy",
      "Loading WorkGraph",
    ])
  })

  test("flags a WorkGraph edge reintroduced into the local surface module", () => {
    // The direction that matters for the package split. A static import here
    // would put `@claxedo/workgraph` back in the unsigned desktop's closure,
    // and making it `lazy()` would not help — the module still has to be
    // reachable for `lazy()` to name it.
    expect(workGraphEagerSurfaceViolations([
      {
        path: WORKGRAPH_SURFACE_FILE,
        text: 'import { WorkGraphContent } from "../../features/workgraph"',
      },
      {
        path: LOCAL_SURFACE_FILE,
        text: 'const WorkGraphContent = lazy(() => import("../../features/workgraph"))',
      },
    ]).map((finding) => finding.match)).toEqual([
      "the local surface module must not reach features/workgraph",
    ])
  })
})
