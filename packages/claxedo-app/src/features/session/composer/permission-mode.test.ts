import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createComposerPermissionMode } from "./permission-mode"
import {
  CLAXEDO_AUTO_ID,
  CLAXEDO_MANUAL_ID,
  type PermissionModeOption,
  type PermissionSelection,
} from "@/features/session/permission/modes"
import type { HarnessId } from "@/platform/identity/session-ref"

function harness(input: {
  harness?: HarnessId
  advertised?: readonly { id: string; name: string; description?: string }[]
  stored?: PermissionSelection
  sessionId?: string
  failDelivery?: boolean
}) {
  const [selection, setSelection] = createSignal<PermissionSelection | undefined>(input.stored)
  const delivered: PermissionModeOption[] = []
  const errors: { error: unknown; option: PermissionModeOption }[] = []

  const control = createComposerPermissionMode({
    harness: () => input.harness,
    advertisedModes: () => input.advertised,
    selection,
    onSelectionChange: setSelection,
    sessionId: () => input.sessionId ?? "ses_1",
    deliver: async (call) => {
      if (input.failDelivery) throw new Error("503 unavailable")
      delivered.push(call.option)
      return { kind: "applied", appliesFrom: "next-turn" }
    },
    onDeliveryError: (err) => errors.push(err),
  })

  return { control, delivered, errors, selection }
}

const rowFor = (control: ReturnType<typeof createComposerPermissionMode>, id: string) =>
  [...(control.groups()?.claxedo ?? []), ...(control.groups()?.harness.rows ?? [])].find(
    (row) => row.option.id === id,
  )

describe("createComposerPermissionMode — defaults", () => {
  test("Auto is the default when nothing is stored", () => {
    createRoot((dispose) => {
      const { control } = harness({ harness: "opencode" })
      expect(control.selection()).toEqual({ kind: "claxedo-auto" })
      expect(control.current()?.id).toBe(CLAXEDO_AUTO_ID)
      expect(control.current()?.name).toBe("Auto")
      dispose()
    })
  })

  test("Auto AND Manual are offered on every harness, because Claxedo owns both", () => {
    const all: HarnessId[] = [
      "opencode",
      "claude-sdk",
      "claude-acp",
      "codex-acp",
      "codex-app-server",
      "cursor-acp",
      "cursor-sdk",
      "pi",
    ]
    for (const id of all) {
      createRoot((dispose) => {
        const { control } = harness({ harness: id, advertised: [] })
        expect(control.groups()?.claxedo.map((row) => row.option.id), id).toEqual([CLAXEDO_AUTO_ID, CLAXEDO_MANUAL_ID])
        dispose()
      })
    }
  })

  // An unidentified harness must not leave the user with NO permission control:
  // Auto and Manual are Claxedo's own and work everywhere. What it must never do is
  // guess a harness and write a ruleset to the wrong engine — so the delivery falls
  // back to local answering, which cannot produce a write at all.
  test("an unidentified harness still offers Claxedo's modes, with a delivery that cannot write", () => {
    createRoot((dispose) => {
      const { control } = harness({})
      const claxedo = control.groups()!.claxedo
      expect(claxedo.map((r) => r.option.id)).toEqual([CLAXEDO_AUTO_ID, CLAXEDO_MANUAL_ID])
      for (const r of claxedo) {
        expect(r.selectable, r.option.id).toBe(true)
        // Never a session ruleset: that would target whichever engine happened to be
        // on the other end of the client.
        expect(r.option.delivery.kind, r.option.id).toBe("claxedo-auto-answer")
      }
      expect(control.groups()!.harness.rows).toEqual([])
      expect(control.groups()!.harness.unavailable).toMatch(/identif/i)
      dispose()
    })
  })
})

describe("createComposerPermissionMode — honesty about what it cannot do", () => {
  // The core guard. Claude advertises real modes, but Claxedo has no delivery for
  // them yet. Listing them as choosable would let the picker claim a policy is
  // active when nothing was ever sent.
  test("modes with no implemented delivery are shown but NOT selectable", () => {
    createRoot((dispose) => {
      const { control } = harness({ harness: "claude-sdk" })
      const rows = control.groups()!.harness.rows
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        expect(row.selectable, row.option.id).toBe(false)
        expect(row.blockedReason, row.option.id).toBeTruthy()
      }
      dispose()
    })
  })

  test("selecting an undeliverable mode changes nothing at all", () => {
    createRoot((dispose) => {
      const { control, delivered, selection } = harness({ harness: "claude-sdk" })
      const claudeAuto = rowFor(control, "auto")!
      expect(claudeAuto.selectable).toBe(false)
      control.select(claudeAuto.option)
      // Neither stored nor sent — a no-op, not a silent partial application.
      expect(selection()).toBeUndefined()
      expect(delivered).toHaveLength(0)
      dispose()
    })
  })

  test("a harness with no modes reports WHY instead of an empty list", () => {
    createRoot((dispose) => {
      const { control } = harness({ harness: "cursor-sdk" })
      expect(control.groups()!.harness.rows).toEqual([])
      expect(control.groups()!.harness.unavailable).toContain("no permission")
      dispose()
    })
  })

  // ACP mode ids are open strings by spec, so "waiting" and "none" are different
  // states and must not collapse into each other.
  test("an ACP harness that has not reported yet says waiting, not none", () => {
    createRoot((dispose) => {
      const waiting = harness({ harness: "claude-acp" })
      expect(waiting.control.groups()!.harness.unavailable).toMatch(/waiting/i)

      const none = harness({ harness: "claude-acp", advertised: [] })
      expect(none.control.groups()!.harness.unavailable).not.toMatch(/waiting/i)
      dispose()
    })
  })

  // A stored id the harness stopped advertising must not silently wear Auto's label
  // while a different selection is stored.
  test("an unresolvable stored selection reports undefined rather than falling back", () => {
    createRoot((dispose) => {
      const { control } = harness({
        harness: "claude-acp",
        advertised: [{ id: "plan", name: "Plan" }],
        stored: { kind: "harness", modeId: "a-mode-that-vanished" },
      })
      expect(control.current()).toBeUndefined()
      dispose()
    })
  })
})

describe("createComposerPermissionMode — selecting", () => {
  test("choosing Auto on opencode stores it and delivers it", () => {
    createRoot((dispose) => {
      const { control, delivered, selection } = harness({
        harness: "opencode",
        stored: { kind: "harness", modeId: "whatever" },
      })
      const auto = rowFor(control, CLAXEDO_AUTO_ID)!
      expect(auto.selectable).toBe(true)
      control.select(auto.option)
      expect(selection()).toEqual({ kind: "claxedo-auto" })
      expect(delivered.map((option) => option.id)).toEqual([CLAXEDO_AUTO_ID])
      dispose()
    })
  })

  // The selection is still worth storing on a draft — the first real session picks
  // it up — but there is no session to scope a ruleset to, so nothing is sent.
  test("a draft stores the choice but sends nothing", () => {
    createRoot((dispose) => {
      const { control, delivered, selection } = harness({ harness: "opencode", sessionId: "" })
      control.select(rowFor(control, CLAXEDO_AUTO_ID)!.option)
      expect(selection()).toEqual({ kind: "claxedo-auto" })
      expect(delivered).toHaveLength(0)
      dispose()
    })
  })

  test("a failed delivery is reported, not swallowed", async () => {
    await createRoot(async (dispose) => {
      const { control, errors } = harness({ harness: "opencode", failDelivery: true })
      control.select(rowFor(control, CLAXEDO_AUTO_ID)!.option)
      await Promise.resolve()
      await Promise.resolve()
      expect(errors).toHaveLength(1)
      expect(errors[0]!.option.id).toBe(CLAXEDO_AUTO_ID)
      dispose()
    })
  })
})

describe("createComposerPermissionMode — Manual is a real way back from Auto", () => {
  // Manual exists because this picker replaced a binary switch, and the switch's OFF
  // state was a capability. Without a selectable Manual the picker would be strictly
  // less capable than the toggle it replaced — you could turn Auto on and never off.
  test("Manual is selectable on every harness", () => {
    const all: HarnessId[] = [
      "opencode",
      "claude-sdk",
      "claude-acp",
      "codex-acp",
      "codex-app-server",
      "cursor-acp",
      "cursor-sdk",
      "pi",
    ]
    for (const id of all) {
      createRoot((dispose) => {
        const { control } = harness({ harness: id, advertised: [] })
        expect(rowFor(control, CLAXEDO_MANUAL_ID)?.selectable, id).toBe(true)
        dispose()
      })
    }
  })

  test("choosing Manual stores Manual, not Auto", () => {
    createRoot((dispose) => {
      const { control, selection, delivered } = harness({ harness: "opencode" })
      control.select(rowFor(control, CLAXEDO_MANUAL_ID)!.option)
      expect(selection()).toEqual({ kind: "claxedo-manual" })
      expect(delivered.map((option) => option.id)).toEqual([CLAXEDO_MANUAL_ID])
      // Deliberately NOT asserting `control.current()` here: it is a createMemo, and
      // an unobserved memo does not recompute, so it would report the pre-selection
      // value regardless of correctness. That resolution is covered directly against
      // the pure `findPermissionModeOption` in permission/modes.test.ts, where no
      // reactive graph is involved and the assertion can actually fail.
      dispose()
    })
  })

  // On opencode Manual must genuinely REVOKE. The grants live in the engine's
  // persisted ruleset and nothing deletes rules, so "ask everything" has to be sent
  // as an explicit later rule or Auto's earlier grants simply keep applying.
  test("Manual on opencode withdraws the grants rather than sending nothing", () => {
    createRoot((dispose) => {
      const { control, delivered } = harness({ harness: "opencode" })
      control.select(rowFor(control, CLAXEDO_MANUAL_ID)!.option)
      const delivery = delivered[0]!.delivery
      if (delivery.kind !== "opencode-session-ruleset") throw new Error("expected a session ruleset")
      for (const permission of ["*", "read", "edit", "question", "bash"]) {
        const last = delivery.ruleset.filter((rule) => rule.permission === permission).at(-1)
        expect(last?.action, permission).toBe("ask")
      }
      // Nothing is allowed. If any rule survived as `allow`, Manual would be a lie.
      expect(delivery.ruleset.every((rule) => rule.action === "ask")).toBe(true)
      dispose()
    })
  })

  // Where Claxedo answers locally, Manual is the absence of answering — modelled as
  // an empty answer list rather than as a missing delivery, so it stays selectable.
  test("Manual elsewhere means Claxedo answers nothing", () => {
    for (const id of ["claude-acp", "pi", "cursor-sdk"] as HarnessId[]) {
      createRoot((dispose) => {
        const { control } = harness({ harness: id, advertised: [] })
        const delivery = rowFor(control, CLAXEDO_MANUAL_ID)!.option.delivery
        if (delivery.kind !== "claxedo-auto-answer") throw new Error(`expected local answering for ${id}`)
        expect(delivery.autoAnswer, id).toEqual([])
        dispose()
      })
    }
  })
})
