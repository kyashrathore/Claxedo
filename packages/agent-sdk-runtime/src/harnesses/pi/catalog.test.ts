import { describe, expect, test } from "bun:test"
import { piModelCatalog } from "./catalog"

describe("piModelCatalog", () => {
  test("enumerates a serializable provider and model catalog", () => {
    const catalog = piModelCatalog()
    const openai = catalog.find((provider) => provider.id === "openai")
    const model = structuredClone(openai?.models[0])

    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog)
    expect(model).toMatchObject({
      provider: "openai",
      id: expect.any(String),
      name: expect.any(String),
      api: expect.any(String),
      reasoning: expect.any(Boolean),
      input: expect.any(Array),
      cost: {
        input: expect.any(Number),
        output: expect.any(Number),
        cacheRead: expect.any(Number),
        cacheWrite: expect.any(Number),
      },
      contextWindow: expect.any(Number),
      maxTokens: expect.any(Number),
    })
  })
})
