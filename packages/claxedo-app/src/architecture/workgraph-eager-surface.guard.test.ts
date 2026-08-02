import { describe, expect, test } from "bun:test"
import path from "node:path"
import { walkProdSources, workGraphEagerSurfaceViolations, workGraphNativePickerViolations } from "./scanners"

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
      path: "app/integrations/first-party-content-surfaces.tsx",
      text: "const result = await platform.openDirectoryPickerDialog({ multiple: false })",
    }]).map((finding) => finding.match)).toEqual(["openDirectoryPickerDialog"])
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
