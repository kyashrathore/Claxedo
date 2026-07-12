import { describe, expect, test } from "bun:test"
import { parseOwnerRepo } from "./rail-git-remote"

// parseOwnerRepo turns a git remote URL into the "owner/repo" label the rail
// shows for a project. It is the derivation railProjectLabel/railProjectCaptionFromName
// build on, so its URL-shape handling is specified directly here.

describe("parseOwnerRepo", () => {
  test("extracts owner/repo from an HTTPS remote with a .git suffix", () => {
    expect(parseOwnerRepo("https://github.com/kyashrathore/Claxedo.git")).toBe("kyashrathore/Claxedo")
  })

  test("extracts owner/repo from an HTTPS remote without a .git suffix", () => {
    expect(parseOwnerRepo("https://github.com/kyashrathore/Claxedo")).toBe("kyashrathore/Claxedo")
  })

  test("extracts owner/repo from an SSH remote with a .git suffix", () => {
    expect(parseOwnerRepo("git@github.com:kyashrathore/Claxedo.git")).toBe("kyashrathore/Claxedo")
  })

  test("extracts owner/repo from an SSH remote without a .git suffix", () => {
    expect(parseOwnerRepo("git@github.com:kyashrathore/Claxedo")).toBe("kyashrathore/Claxedo")
  })

  test("extracts owner/repo from a non-GitHub host such as GitLab", () => {
    expect(parseOwnerRepo("https://gitlab.com/org/project.git")).toBe("org/project")
  })

  test("returns undefined for an undefined remote", () => {
    expect(parseOwnerRepo(undefined)).toBeUndefined()
  })

  test("returns undefined for an empty remote", () => {
    expect(parseOwnerRepo("")).toBeUndefined()
  })
})
