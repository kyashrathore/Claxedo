import { expect, test } from "bun:test"
import { readElicitationSchema, validateElicitationContent } from "./elicitation"

test("elicitation validates primitive types, required fields, choices and numeric limits", () => {
  const schema = readElicitationSchema({ type: "object", properties: {
    title: { type: "string", minLength: 2, maxLength: 8 }, count: { type: "integer", minimum: 1, maximum: 5 }, enabled: { type: "boolean" },
    choices: { type: "array", minItems: 1, maxItems: 2, items: { anyOf: [{ const: "a", title: "A" }, { const: "b", title: "B" }] } },
  }, required: ["title", "count"] })
  const valid = { title: "Hello", count: 2, enabled: false, choices: ["a"] }
  expect(() => validateElicitationContent(schema, valid)).not.toThrow()
  for (const value of [{ ...valid, count: 1.5 }, { ...valid, count: 6 }, { ...valid, title: "a" }, { ...valid, enabled: "false" }, { ...valid, choices: ["c"] }, { ...valid, choices: ["a", "a"] }, { ...valid, choices: [] }, { count: 2 }, { ...valid, extra: true }]) {
    expect(() => validateElicitationContent(schema, value)).toThrow()
  }
})

test("unknown format annotations and schema metadata are preserved", () => {
  const schema = readElicitationSchema({ type: "object", title: "A form", _meta: { origin: "agent" }, properties: { value: { type: "string", format: "custom-label" } } })
  expect(schema).toMatchObject({ title: "A form", _meta: { origin: "agent" }, properties: { value: { format: "custom-label" } } })
  expect(() => validateElicitationContent(schema, { value: "arbitrary" })).not.toThrow()
})

test("pattern constraints are preserved structurally without executing them", () => {
  expect(readElicitationSchema({ type: "object", properties: { name: { type: "string", pattern: "(a+)+$" } } }).properties.name?.pattern).toBe("(a+)+$")
})

test("date formats require actual calendar dates and RFC3339 timestamps with timezones", () => {
  for (const [format, valid, invalid] of [
    ["date", ["2024-02-29", "2000-02-29", "2026-12-31"], ["2026-02-30", "1900-02-29", "2026-04-31", "2026-00-01", "2026-01-00", "2026"]],
    ["date-time", ["2024-02-29T12:30:59Z", "2026-09-20t12:30:15.123z", "2026-09-20T12:30:15+05:30", "2026-09-20T12:30:15-07:00", "2016-12-31T23:59:60Z", "2017-01-01T05:29:60+05:30"],
      ["2026", "2026-02-30T12:30:00Z", "2026-09-20", "2026-09-20T12:30:00", "2026-09-20 12:30:00Z", "2026-09-20T24:00:00Z", "2026-09-20T12:60:00Z", "2026-09-20T12:30:61Z", "2026-09-20T12:30:60Z", "2026-09-20T23:59:60Z", "2026-09-20T12:30:00+24:00", "2026-09-20T12:30:00+05:60"]],
  ] as const) {
    const schema = readElicitationSchema({ type: "object", properties: { value: { type: "string", format } } })
    for (const value of valid) expect(() => validateElicitationContent(schema, { value })).not.toThrow()
    for (const value of invalid) expect(() => validateElicitationContent(schema, { value })).toThrow()
  }
})


test("string length counts Unicode code points rather than UTF16 units or graphemes", () => {
  const one = readElicitationSchema({ type: "object", properties: { value: { type: "string", minLength: 1, maxLength: 1 } } })
  expect(() => validateElicitationContent(one, { value: "😀" })).not.toThrow()
  expect(() => validateElicitationContent(one, { value: "😀😀" })).toThrow()
  expect(() => validateElicitationContent(one, { value: "e\u0301" })).toThrow()
})
