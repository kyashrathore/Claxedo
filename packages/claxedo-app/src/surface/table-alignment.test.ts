/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { columnAlignment } from "./table-alignment"

describe("columnAlignment", () => {
  test("right-aligns a column whose present values are all numbers", () => {
    const rows = [{ service: "api", p95: 182 }, { service: "web", p95: 96.5 }, { service: "worker", p95: "" }, { service: "cron" }]
    expect(columnAlignment(rows, "p95")).toBe("end")
    expect(columnAlignment(rows, "service")).toBe("start")
  })

  test("keeps a column of numeric strings, a mixed column and an empty column at the start", () => {
    expect(columnAlignment([{ v: "12" }, { v: "13" }], "v")).toBe("start")
    expect(columnAlignment([{ v: 12 }, { v: "n/a" }], "v")).toBe("start")
    expect(columnAlignment([{}, { v: null }], "v")).toBe("start")
  })
})
