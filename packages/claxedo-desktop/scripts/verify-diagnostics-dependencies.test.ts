import { expect, test } from "bun:test"

import {
  acceptedDiagnosticsDependencies,
  acceptedDiagnosticsTransitives,
  verifyDiagnosticsDependencies,
} from "./verify-diagnostics-dependencies"

test("exact diagnostics dependencies match the reviewed license, integrity, and lifecycle policy", async () => {
  const report = await verifyDiagnosticsDependencies()

  expect(report.failures).toEqual([])
  expect(report.dependencies.map((dependency) => dependency.name)).toEqual(
    [...Object.keys(acceptedDiagnosticsDependencies), ...Object.keys(acceptedDiagnosticsTransitives)],
  )
  expect(report.dependencies.filter((dependency) => dependency.native).map((dependency) => dependency.name)).toEqual([
    "@vscode/windows-process-tree",
  ])
})
