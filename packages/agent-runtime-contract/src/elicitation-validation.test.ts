import { expect, test } from "bun:test"
import { readElicitationSchema } from "./elicitation"
import { ElicitationValidationError, elicitationPatternChecks, validateElicitationUrl, validateElicitationResponse } from "./elicitation-validation"

test("complete validator checks primitive constraints before pattern execution", async () => {
  const schema = readElicitationSchema({ type: "object", properties: { value: { type: "string", pattern: "^yes$" } }, required: ["value"] })
  let called = false
  await expect(validateElicitationResponse(schema, {}, async () => { called = true })).rejects.toMatchObject({ code: "invalid_answer" })
  expect(called).toBe(false)
  expect(await validateElicitationResponse(schema, { value: "yes" }, async (checks) => {
    expect(checks).toEqual([{ field: "value", pattern: "^yes$", value: "yes" }])
  })).toEqual({ value: "yes" })
})

test("pattern resource bounds reject before evaluator dispatch", async () => {
  const schema = readElicitationSchema({ type: "object", properties: { value: { type: "string", pattern: "a" } } })
  await expect(validateElicitationResponse(schema, { value: "a".repeat(65537) }, async () => { throw new Error("must not execute") })).rejects.toMatchObject({ code: "invalid_answer" })
  schema.properties.value!.pattern = "a".repeat(4097)
  expect(() => elicitationPatternChecks(schema)).toThrow(ElicitationValidationError)
  const many = readElicitationSchema({ type: "object", properties: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [i, { type: "string", pattern: "" }])) })
  expect(() => elicitationPatternChecks(many)).toThrow("limits")
})

test("consent URL validation permits HTTP links without credentials and rejects active URLs", () => {
  for (const value of ["https://example.com/auth", "http://localhost:4446/auth"]) expect(() => validateElicitationUrl(value)).not.toThrow()
  for (const value of ["javascript:alert(1)", "data:text/html,test", "https://user:secret@example.com", "not a URL"]) expect(() => validateElicitationUrl(value)).toThrow()
})
