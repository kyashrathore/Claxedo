import path from "path"
import { describe, expect, test } from "bun:test"
import { assertSafePathSegment } from "../fs-safe"
import { cursorLocalPluginDir } from "./cursor"
import { skillTargetDir } from "./skills"

describe("path-segment safety at materializer boundaries (H4)", () => {
  test("assertSafePathSegment accepts ordinary component names", () => {
    for (const name of ["review", "my-skill.v2", "café notes", ".hidden", "..dots", "a_b-c"]) {
      expect(assertSafePathSegment(name, "component name")).toBe(name)
    }
  })

  test("assertSafePathSegment rejects traversal and separator strings", () => {
    for (const name of ["..", ".", "", "../escape", "a/b", "a\\b", "nested/path", "\0"]) {
      expect(() => assertSafePathSegment(name, "component name")).toThrow("single safe path segment")
    }
  })

  test("skill target dir refuses a repo-controlled traversal name", () => {
    expect(() => skillTargetDir({
      runner: "claude",
      scope: "machine",
      name: "../../.ssh",
      homeDir: "/home/user",
    })).toThrow("single safe path segment")
    expect(skillTargetDir({
      runner: "claude",
      scope: "project",
      name: "review",
      projectDir: "/proj",
    })).toBe(path.join("/proj", ".claude", "skills", "review"))
  })

  test("cursor plugin dir refuses a manifest-controlled traversal name", () => {
    expect(() => cursorLocalPluginDir({
      homeDir: "/home/user",
      pluginName: "../overwrite-me",
    })).toThrow("single safe path segment")
    expect(cursorLocalPluginDir({
      homeDir: "/home/user",
      pluginName: "notes",
    })).toBe(path.join("/home/user", ".cursor", "plugins", "local", "notes"))
  })
})
