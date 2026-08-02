import { describe, expect, test } from "vitest"
import { sessionMatchesDocumentProject } from "./session-grants"

describe("document session project grants", () => {
  test("accepts the canonical directory project when legacy session project identity differs", () => {
    expect(
      sessionMatchesDocumentProject({
        documentProjectId: "project-canonical",
        sessionProjectId: "project-legacy",
        sessionDirectory: "/repo",
        resolveDirectoryProjectId: () => "project-canonical",
      }),
    ).toBe(true)
  })

  test("rejects a session whose persisted and directory-derived projects are both different", () => {
    expect(
      sessionMatchesDocumentProject({
        documentProjectId: "project-a",
        sessionProjectId: "project-b",
        sessionDirectory: "/other",
        resolveDirectoryProjectId: () => "project-c",
      }),
    ).toBe(false)
  })

  test("uses canonical directory identity when persisted project metadata contradicts it", () => {
    const input = {
      sessionProjectId: "project-a",
      sessionDirectory: "/project-b",
      resolveDirectoryProjectId: () => "project-b",
    }
    expect(sessionMatchesDocumentProject({ ...input, documentProjectId: "project-a" })).toBe(false)
    expect(sessionMatchesDocumentProject({ ...input, documentProjectId: "project-b" })).toBe(true)
  })
})
