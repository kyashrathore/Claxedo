import { describe, expect, test } from "vitest"
import { applySessionFilter } from "./session-filter"

describe("applySessionFilter", () => {
  test("leaves active view unforced and sends only explicit filters", () => {
    const url = new URL("http://localhost/experimental/session")
    applySessionFilter(url, {
      archived: "active",
      status: ["review"],
      environment: ["local"],
      git: ["repo:Claxedo"],
    })

    expect(url.searchParams.get("archived")).toBeNull()
    expect(url.searchParams.get("filter.status")).toBe("review")
    expect(url.searchParams.get("filter.environment")).toBe("local")
    expect(url.searchParams.get("filter.git")).toBe("repo:Claxedo")
  })

  test("sends explicit all and archived modes to the server", () => {
    const all = new URL("http://localhost/experimental/session")
    applySessionFilter(all, { archived: "all" })
    expect(all.searchParams.get("archived")).toBe("all")

    const archived = new URL("http://localhost/experimental/session")
    applySessionFilter(archived, { archived: "archived" })
    expect(archived.searchParams.get("archived")).toBe("archived")
  })
})
