import { expect, test } from "bun:test"
import { vendorName } from "./vendor-providers"

test("a stored account's provider id is named by its vendor, whether it is a harness binding, a vendor or a Pi provider, and an unknown id by itself", () => {
  expect(vendorName("claude-sdk")).toBe("Anthropic")
  expect(vendorName("anthropic")).toBe("Anthropic")
  expect(vendorName("codex-app-server")).toBe("OpenAI")
  expect(vendorName("openai")).toBe("OpenAI")
  expect(vendorName("cursor")).toBe("Cursor")
  expect(vendorName("openrouter")).toBe("OpenRouter")
  expect(vendorName("xai")).toBe("xAI")
  expect(vendorName("someone-else")).toBe("someone-else")
})
