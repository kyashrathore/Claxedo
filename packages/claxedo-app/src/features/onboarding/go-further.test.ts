import { describe, expect, test } from "bun:test"
import { onboardingGoFurtherCards } from "./go-further"

const card = (id: string) => onboardingGoFurtherCards.find((item) => item.id === id)!

describe("go-further cards", () => {
  test("remote access is a setup step now, not a card", () => {
    expect(onboardingGoFurtherCards.map((item) => item.id)).toEqual(["harnesses", "self-host"])
  })

  test("the harness card promises only what the check actually reports", () => {
    // It opens the AI step's local check, which covers exactly Claude Code,
    // Codex, and Cursor. The previous copy promised "any runnable harness" and
    // opened a provider CONNECT dialog — wrong surface AND wrong scope, so a
    // user arrived looking for rows that were never going to be there.
    const harnesses = card("harnesses")
    expect(harnesses.title).toContain("Claude Code")
    expect(harnesses.title).toContain("Codex")
    expect(harnesses.title).toContain("Cursor")
    expect(harnesses.education).not.toMatch(/any (agent )?harness/i)
  })

  test("self-host is offered everywhere except where it already is the answer", () => {
    expect(card("self-host").appliesTo("desktop")).toBe(true)
    expect(card("self-host").appliesTo("self-host")).toBe(false)
  })

  test("every card names an action, so none is a dead end", () => {
    for (const item of onboardingGoFurtherCards) {
      expect(item.action.length).toBeGreaterThan(0)
      expect(item.education.length).toBeGreaterThan(0)
    }
  })
})
