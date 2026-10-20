/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { keyValueRows } from "./key-value"

describe("keyValueRows", () => {
  test("keeps each labelled object of a bound list in order", () => {
    const bound = [{ label: "Region", value: "eu-west" }, "stray", null, ["x"], { value: "no label" }, { label: "Owner", value: { path: "owner" } }]
    expect(keyValueRows(bound)).toEqual([{ label: "Region", value: "eu-west" }, { label: "Owner", value: { path: "owner" } }])
  })

  test("draws no rows for a binding that does not hold a list", () => {
    expect(keyValueRows(undefined)).toEqual([])
    expect(keyValueRows({ label: "Region", value: "eu-west" })).toEqual([])
  })
})
