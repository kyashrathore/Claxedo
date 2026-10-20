/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { keyValueRows } from "./key-value"

describe("keyValueRows", () => {
  test("keeps each labelled object of a bound list in order", () => {
    const bound = [{ label: "Region", value: "eu-west" }, "stray", null, ["x"], { value: "no label" }, { label: "Owner", value: { path: "owner" } }]
    expect(keyValueRows(bound, false)).toEqual([
      { label: "Region", kind: "text", value: "eu-west" },
      { label: "Owner", kind: "text", value: { path: "owner" } },
    ])
  })

  test("draws no rows for a binding that does not hold a list", () => {
    expect(keyValueRows(undefined, false)).toEqual([])
    expect(keyValueRows({ label: "Region", value: "eu-west" }, false)).toEqual([])
  })

  test("draws a literal item's child component as its value, and never a child named by bound data", () => {
    const items = [{ label: "Status", child: "status-chip" }, { label: "Created", value: "Oct 19" }]
    expect(keyValueRows(items, true)).toEqual([
      { label: "Status", kind: "child", child: "status-chip" },
      { label: "Created", kind: "text", value: "Oct 19" },
    ])
    expect(keyValueRows(items, false)[0]).toEqual({ label: "Status", kind: "text", value: undefined })
  })
})
