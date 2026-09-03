import { describe, expect, test } from "vitest"

import { documentsServiceHttp } from "./http"

describe("Documents Worker public HTTP surface", () => {
  test.each(["GET", "POST"])("returns 404 for %s instead of exposing a route", async (method) => {
    const response = await documentsServiceHttp.fetch(new Request("https://documents.internal/anything", { method }))
    expect(response.status).toBe(404)
    expect(await response.text()).toBe("Not Found")
  })
})
