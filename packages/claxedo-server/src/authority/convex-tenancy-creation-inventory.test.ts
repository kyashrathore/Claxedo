import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"

const root = path.resolve(import.meta.dirname, "../../../..")

function convexSources() {
  return fs.readdirSync(path.join(root, "convex"))
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => ({
      file,
      source: fs.readFileSync(path.join(root, "convex", file), "utf8"),
    }))
}

function insertWindows(table: string) {
  return convexSources().flatMap(({ file, source }) => {
    const lines = source.split("\n")
    return lines.flatMap((line, index) => line.includes(`insert("${table}"`)
      ? [{ file, window: lines.slice(Math.max(0, index - 25), index + 30).join("\n") }]
      : [])
  })
}

describe("Convex tenancy creation inventory", () => {
  test("every workspace insert assigns org and project identity at first write", () => {
    const inserts = insertWindows("workspaces")
    expect(inserts.map((insert) => insert.file).sort()).toEqual([
      "workspaces.ts",
      "workspaces.ts",
      "workspaces.ts",
    ])
    for (const insert of inserts) {
      expect(insert.window, insert.file).toMatch(/org_id\s*:/)
      expect(insert.window, insert.file).toMatch(/project_id\s*:/)
    }
  })

  test("personal-org creation remains limited to its three named boundaries", () => {
    const personal = insertWindows("orgs").filter((insert) => /kind\s*:\s*"personal"/.test(insert.window))
    expect(personal.map((insert) => insert.file).sort()).toEqual(["billing.ts", "orgs.ts", "workspaces.ts"])
  })
})
