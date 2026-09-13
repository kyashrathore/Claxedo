import { describe, expect, test } from "bun:test"
import {
  parseSessionModelGroup,
  parseStoredSessionModelGroup,
  SESSION_GROUP_SLOTS,
  sessionModelGroupJson,
} from "./session-group"

const PRIMARY = {
  harness: { id: "claude", access: "native" },
  model: { providerID: "anthropic", modelID: "claude-opus-4-1" },
  effort: "high",
}

describe("parseSessionModelGroup", () => {
  test("keeps every named slot with its harness, model and effort", () => {
    const result = parseSessionModelGroup({
      primary: PRIMARY,
      review: { harness: "codex", model: { providerID: "openai", modelID: "gpt-5-codex" } },
    })
    expect(result).toEqual({
      group: {
        primary: {
          harness: { id: "claude", access: "native" },
          model: { providerID: "anthropic", modelID: "claude-opus-4-1" },
          effort: "high",
        },
        review: {
          harness: { id: "codex", access: "native" },
          model: { providerID: "openai", modelID: "gpt-5-codex" },
        },
      },
    })
  })

  test("accepts an empty group and every slot the contract names", () => {
    expect(parseSessionModelGroup({})).toEqual({ group: {} })
    const all = Object.fromEntries(SESSION_GROUP_SLOTS.map((slot) => [slot, PRIMARY]))
    const result = parseSessionModelGroup(all)
    expect("group" in result && Object.keys(result.group).sort()).toEqual([...SESSION_GROUP_SLOTS].sort())
  })

  test("names the field it refused rather than dropping the slot", () => {
    expect(parseSessionModelGroup({ archivist: PRIMARY })).toMatchObject({ field: "group.archivist" })
    expect(parseSessionModelGroup({ primary: "claude" })).toMatchObject({ field: "group.primary" })
    expect(parseSessionModelGroup({ primary: { ...PRIMARY, harness: { id: "nosuch", access: "native" } } }))
      .toMatchObject({ field: "group.primary.harness" })
    expect(parseSessionModelGroup({ planning: { harness: "claude" } }))
      .toMatchObject({ field: "group.planning.model" })
    expect(parseSessionModelGroup({ planning: { ...PRIMARY, model: { providerID: "anthropic", id: "opus" } } }))
      .toMatchObject({ field: "group.planning.model" })
    expect(parseSessionModelGroup({ review: { ...PRIMARY, effort: "" } }))
      .toMatchObject({ field: "group.review.effort" })
    expect(parseSessionModelGroup({ review: { ...PRIMARY, effort: 3 } }))
      .toMatchObject({ field: "group.review.effort" })
    expect(parseSessionModelGroup("primary")).toMatchObject({ field: "group" })
  })
})

describe("stored round trip", () => {
  test("survives the column it is written to and back", () => {
    const parsed = parseSessionModelGroup({ implementation: PRIMARY })
    if (!("group" in parsed)) throw new Error("fixture group did not parse")
    const json = sessionModelGroupJson(parsed.group)
    expect(json).toBeString()
    expect(parseStoredSessionModelGroup(json)).toEqual(parsed.group)
  })

  test("an empty group is stored as no group at all", () => {
    expect(sessionModelGroupJson({})).toBeNull()
    expect(sessionModelGroupJson(null)).toBeNull()
    expect(sessionModelGroupJson(undefined)).toBeNull()
  })

  test("a row that is not a valid group reads back as none instead of a half group", () => {
    expect(parseStoredSessionModelGroup(null)).toBeUndefined()
    expect(parseStoredSessionModelGroup("not json")).toBeUndefined()
    expect(parseStoredSessionModelGroup(JSON.stringify({ primary: { harness: "nosuch" } }))).toBeUndefined()
    expect(parseStoredSessionModelGroup(JSON.stringify({}))).toBeUndefined()
  })
})
