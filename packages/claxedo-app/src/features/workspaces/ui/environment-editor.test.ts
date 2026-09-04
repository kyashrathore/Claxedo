import { describe, expect, test } from "bun:test"
import { environmentRecord, environmentRows, environmentRowsProblem } from "./environment-editor"

describe("environment editor rules", () => {
  test("rows round-trip through a record, dropping empty lines", () => {
    const rows = environmentRows({ DATABASE_URL: "postgres://localhost/demo", NODE_ENV: "development" })
    expect(rows.map((row) => row.name)).toEqual(["DATABASE_URL", "NODE_ENV"])
    expect(environmentRecord([...rows, { id: 9, name: "", value: "" }])).toEqual({
      DATABASE_URL: "postgres://localhost/demo",
      NODE_ENV: "development",
    })
    expect(environmentRows(undefined)).toEqual([{ id: 1, name: "", value: "" }])
  })

  test("names must be variable names, unique, and present when a value is", () => {
    expect(environmentRowsProblem([{ id: 1, name: "1BAD", value: "x" }])).toMatch(/not a valid variable name/)
    expect(
      environmentRowsProblem([
        { id: 1, name: "KEY", value: "a" },
        { id: 2, name: "KEY", value: "b" },
      ]),
    ).toMatch(/listed twice/)
    expect(environmentRowsProblem([{ id: 1, name: "", value: "orphan" }])).toMatch(/needs a variable name/)
    expect(
      environmentRowsProblem([
        { id: 1, name: "OK_1", value: "" },
        { id: 2, name: "", value: "" },
      ]),
    ).toBeUndefined()
  })
})
