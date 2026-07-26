import { describe, expect, test } from "bun:test"
import { permissionRowText } from "./permission-control"
import type { PermissionModeRow } from "@/features/session/composer/permission-mode"
import type { PermissionModeOption } from "@/features/session/permission/modes"

/**
 * The caveat was dropped from the rendered row while `modes.ts` kept producing
 * it and `modes.test.ts` kept asserting it existed — so the suite stayed green
 * while the warning stopped reaching anyone. Asserting that the option OBJECT
 * carries a caveat is not enough; something has to assert it survives the trip
 * into what the row displays.
 */

function row(option: Partial<PermissionModeOption>, extra: Partial<PermissionModeRow> = {}): PermissionModeRow {
  return {
    option: {
      id: "claxedo-allow-safe",
      name: "Allow reads and edits",
      description: "Reads and in-project edits run without asking",
      origin: "claxedo",
      delivery: { kind: "claxedo-auto-answer", autoAnswer: [], respondWith: "once" },
      ...option,
    } as PermissionModeOption,
    selectable: true,
    ...extra,
  }
}

describe("permissionRowText", () => {
  test("keeps the caveat separate from the detail line", () => {
    const text = permissionRowText(
      row({ description: "Everything runs unattended", caveat: "the harness enforces nothing" }),
    )
    expect(text.detail).toBe("Everything runs unattended")
    expect(text.caveat).toBe("the harness enforces nothing")
  })

  test("a caveat is never silently folded away", () => {
    // The exact regression: `caveat` fell out of the assembled parts.
    const danger = "Claxedo answers these prompts on your behalf; the harness enforces nothing"
    expect(permissionRowText(row({ caveat: danger })).caveat).toBe(danger)
  })

  test("no caveat means no caveat", () => {
    expect(permissionRowText(row({})).caveat).toBeUndefined()
  })

  test("a blocked row explains why, in the detail line", () => {
    const text = permissionRowText(
      row({ description: "Auto-approve" }, { selectable: false, blockedReason: "cursor-sdk exposes no controls" }),
    )
    expect(text.detail).toBe("Auto-approve — cursor-sdk exposes no controls")
  })

  test("the tooltip carries everything, because the detail line is clamped", () => {
    const text = permissionRowText(
      row({ description: "Auto-approve", caveat: "needs a model that supports it" }, { blockedReason: "not wired" }),
    )
    expect(text.tooltip).toBe("Auto-approve — not wired — needs a model that supports it")
  })

  test("a row with nothing to say still names itself", () => {
    const text = permissionRowText(row({ description: undefined, name: "Ask for everything" }))
    expect(text.tooltip).toBe("Ask for everything")
  })
})
