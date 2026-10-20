/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { badgeTagVariant, badgeTone, CALLOUT_ICONS } from "./tones"

describe("tones", () => {
  test("draws only accent badges with the kit's accent tag; status tones restyle a neutral tag", () => {
    expect(badgeTagVariant("accent")).toBe("accent")
    expect((["neutral", "success", "warning", "danger"] as const).map(badgeTagVariant)).toEqual(["neutral", "neutral", "neutral", "neutral"])
  })

  test("reads a bound tone from data and falls back to neutral for anything else", () => {
    expect(["success", "danger", "bogus", undefined, 3].map(badgeTone)).toEqual(["success", "danger", "neutral", "neutral", "neutral"])
  })

  test("gives each callout tone its own icon", () => {
    expect(new Set(Object.values(CALLOUT_ICONS)).size).toBe(Object.keys(CALLOUT_ICONS).length)
    expect(CALLOUT_ICONS.warning).toBe("warning")
  })
})
