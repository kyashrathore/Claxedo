import { describe, expect, test } from "bun:test"
import path from "node:path"
import { walkProdSources, workGraphLazySurfaceViolations, workGraphNativePickerViolations } from "./scanners"

const appRoot = path.resolve(import.meta.dir, "../..")

describe("WorkGraph lazy surface guard", () => {
  test("keeps WorkGraph behind a lazy chunk boundary", () => {
    expect(workGraphLazySurfaceViolations(walkProdSources(appRoot))).toEqual([])
  })

  test("picks project folders with the in-app dialog, never the OS-native picker", () => {
    expect(workGraphNativePickerViolations(walkProdSources(appRoot))).toEqual([])
  })

  test("flags a reintroduced native directory picker on the WorkGraph surface", () => {
    expect(workGraphNativePickerViolations([{
      path: "app/integrations/workgraph-content-surfaces.tsx",
      text: "const result = await platform.openDirectoryPickerDialog({ multiple: false })",
    }]).map((finding) => finding.match)).toEqual(["openDirectoryPickerDialog"])
  })

  test("flags a reintroduced eager WorkGraph surface", () => {
    expect(workGraphLazySurfaceViolations([{
      path: "app/integrations/first-party-content-surfaces.tsx",
      text: 'import { WorkGraphSurface } from "./workgraph-content-surfaces"',
    }, {
      path: "app/integrations/workgraph-content-surfaces.tsx",
      text: "export function WorkGraphSurface() {}",
    }]).map((finding) => finding.match)).toEqual([
      'import { WorkGraphSurface } from "./workgraph-content-surfaces"',
      "WorkGraph surfaces must use a lazy import boundary",
    ])
  })
})
