import { afterEach, describe, expect, test } from "bun:test"
import { createRenderEffect, createSignal } from "solid-js"
import { createComposerAutoAccept } from "./auto-accept"
import { mountReactive } from "@/lib/test-support/reactive-root"
import type { PermissionModeDelivery } from "@/features/session/permission/modes"

type Delivered = { delivery: PermissionModeDelivery; sessionID: string }

// Each `harness()` owns a reactive root; a test may build more than one.
const mounted: (() => void)[] = []
afterEach(() => {
  while (mounted.length) mounted.pop()!()
})

function harness(input: { sessionId?: string; harness?: string; startsOn?: boolean; failDelivery?: boolean }) {
  // A real SIGNAL, not a plain field. This matters: `active()` is a createMemo, so a
  // non-reactive backing store would leave it caching the pre-toggle value and the
  // "delivers the direction the user chose" test would pass even with the read and
  // the flip in the wrong order. A first draft of this file did exactly that, and a
  // deliberately-inverted implementation still went green.
  const [on, setOn] = createSignal(input.startsOn ?? false)
  const calls: string[] = []
  const delivered: Delivered[] = []
  const errors: { error: unknown; enabling: boolean }[] = []

  const permission = {
    isAutoAccepting: () => on(),
    isAutoAcceptingDirectory: () => on(),
    toggleAutoAccept: (sessionID: string) => {
      calls.push(`session:${sessionID}`)
      setOn((value) => !value)
    },
    toggleAutoAcceptDirectory: (directory: string) => {
      calls.push(`directory:${directory}`)
      setOn((value) => !value)
    },
  } satisfies Parameters<typeof createComposerAutoAccept>[0]["permission"]

  // The control and its observer are the only things that need an owner. The
  // toggles below run OUTSIDE it, the way the composer's switch calls them:
  // Solid 2's dev build throws `REACTIVE_WRITE_IN_OWNED_SCOPE` for a setter
  // reached with an owner on the stack, which a test body wrapped in
  // `createRoot` would have on every line.
  //
  // OBSERVE `active()`. This is not decoration — a Solid memo with no observer is
  // never recomputed, so reading it after a signal change returns the STALE value.
  // Verified directly: `setOn(true)` then `active()` still returned false. Without
  // this, the ordering test below cannot discriminate, because `active()` would be
  // stale whether the implementation reads it before or after the flip. In
  // production the memo is observed (the switch's checked state reads it), which is
  // exactly why the ordering matters there. Render effect rather than createEffect
  // so it runs synchronously instead of being queued.
  //
  // Two arguments: Solid 2's `createRenderEffect(compute, effectFn)` mirrors
  // `createEffect`. Called with one, `node._effectFn` is undefined and the first
  // run throws inside `runEffect`, which HALTS the reactive system for the rest
  // of the file — every later test in it then failed on stale state.
  const [control, dispose] = mountReactive(() => {
    const control = createComposerAutoAccept({
      permission,
      sessionId: () => input.sessionId,
      directory: () => "/work/repo",
      harness: () => (input.harness as never) ?? undefined,
      deliver: async (call) => {
        if (input.failDelivery) throw new Error("503 unavailable")
        delivered.push(call)
        return { kind: "applied", appliesFrom: "next-turn" }
      },
      onDeliveryError: (err) => errors.push(err),
    })
    createRenderEffect(
      () => control.active(),
      () => {},
    )
    return control
  })
  mounted.push(dispose)

  return { control, delivered, errors, calls, on }
}

const actionsFor = (delivery: PermissionModeDelivery, permission: string) => {
  if (delivery.kind !== "opencode-session-ruleset") throw new Error("expected a session ruleset")
  return delivery.ruleset.filter((rule) => rule.permission === permission).map((rule) => rule.action)
}

describe("createComposerAutoAccept — opencode native delivery", () => {
  test("enabling pushes the Auto ruleset so the engine stops asking", async () => {
    const { control, delivered } = harness({ sessionId: "ses_1", harness: "opencode" })
    control.toggle()
    await Promise.resolve()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.sessionID).toBe("ses_1")
    expect(actionsFor(delivered[0]!.delivery, "read")).toContain("allow")
    expect(actionsFor(delivered[0]!.delivery, "bash")).toEqual(["ask"])
  })

  // The security-critical direction. Enabling writes grants into opencode's own
  // PERSISTED ruleset, so if disabling did not withdraw them the switch would be
  // one-way: it reads "off" while the engine still allows. There is no endpoint that
  // deletes rules, so withdrawal has to be an explicit later `ask`.
  test("disabling WITHDRAWS the grants rather than just flipping the local switch", async () => {
    const { control, delivered } = harness({ sessionId: "ses_1", harness: "opencode", startsOn: true })
    control.toggle()
    await Promise.resolve()
    expect(delivered).toHaveLength(1)
    // Every previously granted permission is asked again.
    for (const permission of ["read", "edit", "question", "glob"]) {
      expect(actionsFor(delivered[0]!.delivery, permission), permission).toEqual(["ask"])
    }
    expect(actionsFor(delivered[0]!.delivery, "*")).toEqual(["ask"])
  })

  // Regression guard: `active()` is the CURRENT state, so the intent has to be read
  // before the local toggle mutates it. Reading after would deliver Auto when
  // disabling and the revocation when enabling — exactly backwards, and silent.
  test("delivers the direction the user chose, not its opposite", async () => {
    const on = harness({ sessionId: "ses_1", harness: "opencode", startsOn: false })
    on.control.toggle()
    await Promise.resolve()
    expect(actionsFor(on.delivered[0]!.delivery, "read")).toContain("allow")

    const off = harness({ sessionId: "ses_1", harness: "opencode", startsOn: true })
    off.control.toggle()
    await Promise.resolve()
    expect(actionsFor(off.delivered[0]!.delivery, "read")).toEqual(["ask"])
  })
})

describe("createComposerAutoAccept — when there is nothing to deliver", () => {
  test("a draft with no session delivers nothing and still toggles the directory", async () => {
    const { control, delivered, calls } = harness({ harness: "opencode" })
    control.toggle()
    await Promise.resolve()
    expect(delivered).toHaveLength(0)
    expect(calls).toEqual(["directory:/work/repo"])
  })

  // Non-opencode harnesses have no session ruleset to write. They must fall through
  // to local answering rather than having a ruleset pushed at them.
  test("non-opencode harnesses deliver nothing", async () => {
    for (const id of ["claude-sdk", "claude-acp", "codex-acp", "codex-app-server", "cursor-sdk", "pi"]) {
      const { control, delivered } = harness({ sessionId: "ses_1", harness: id })
      control.toggle()
      await Promise.resolve()
      expect(delivered, id).toHaveLength(0)
    }
  })

  test("an unknown harness delivers nothing instead of guessing", async () => {
    const { control, delivered } = harness({ sessionId: "ses_1" })
    control.toggle()
    await Promise.resolve()
    expect(delivered).toHaveLength(0)
  })
})

describe("createComposerAutoAccept — failure is reported, not swallowed", () => {
  // The local switch has already flipped when the write fails. Silence would leave
  // the user believing the engine was told something it never received.
  test("a failed delivery reports through onDeliveryError and does not throw", async () => {
    const { control, errors, on } = harness({ sessionId: "ses_1", harness: "opencode", failDelivery: true })
    expect(() => control.toggle()).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    expect(errors).toHaveLength(1)
    expect(errors[0]!.enabling).toBe(true)
    // The local behaviour still applied — degrading to "Claxedo answers these" is
    // the point of not awaiting the write before flipping.
    expect(on()).toBe(true)
  })

  test("a failed WITHDRAWAL is reported as such, so the user knows grants may be live", async () => {
    const { control, errors } = harness({
      sessionId: "ses_1",
      harness: "opencode",
      startsOn: true,
      failDelivery: true,
    })
    control.toggle()
    await Promise.resolve()
    await Promise.resolve()
    expect(errors).toHaveLength(1)
    expect(errors[0]!.enabling).toBe(false)
  })
})
