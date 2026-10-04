import { describe, expect, test } from "bun:test"
import { routeParam } from "./route-param"

describe("routeParam", () => {
  test("returns the param the router matched", () => {
    const c = { req: { param: (name: string) => (name === "id" ? "ses_1" : undefined) } }
    expect(routeParam(c, "id")).toBe("ses_1")
  })

  test("a param the mounted path does not carry is a mount mistake, not an empty value", () => {
    const c = { req: { param: () => undefined } }
    expect(() => routeParam(c, "id")).toThrow("Route param id is not on the mounted path")
  })
})
