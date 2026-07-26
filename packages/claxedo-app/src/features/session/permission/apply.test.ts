import { describe, expect, test } from "bun:test"
import { applyPermissionMode, permissionModeDeliverable, type SessionPermissionWriter } from "./apply"
import { CLAXEDO_ALLOW_SAFE_ID, claxedoPermissionModes, type PermissionModeDelivery } from "./modes"

/** The permissive Claxedo option for a harness, which is what these tests deliver. */
const permissive = (harness: Parameters<typeof claxedoPermissionModes>[0]) =>
  claxedoPermissionModes({ harness }).find((option) => option.id === CLAXEDO_ALLOW_SAFE_ID)!

type Call = {
  sessionID: string
  permission?: readonly { permission: string; pattern: string; action: string }[]
}

const writer = () => {
  const calls: Call[] = []
  const client: SessionPermissionWriter = {
    session: {
      update: async (input) => {
        calls.push(input as Call)
        return {}
      },
    },
  }
  return { client, calls }
}

describe("applyPermissionMode — opencode", () => {
  // The whole point of this module. `PATCH /config` disposes the engine instance on
  // EVERY request, which hard-interrupts every running turn in the directory and
  // wipes in-memory "allow always" grants. The session route does neither.
  test("writes the ruleset through the session route, never a config route", async () => {
    const { client, calls } = writer()
    const result = await applyPermissionMode({
      delivery: permissive("opencode").delivery,
      sessionID: "ses_1",
      client,
    })

    expect(result).toEqual({ kind: "applied", appliesFrom: "next-turn" })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.sessionID).toBe("ses_1")
    expect(calls[0]!.permission).toBeDefined()
  })

  // The engine merges rather than replaces, so an omitted permission silently keeps
  // whatever the previous mode left in the array.
  test("sends the complete ruleset, not a partial patch", async () => {
    const { client, calls } = writer()
    await applyPermissionMode({
      delivery: permissive("opencode").delivery,
      sessionID: "ses_1",
      client,
    })

    const sent = calls[0]!.permission!
    const names = new Set(sent.map((rule) => rule.permission))
    for (const permission of ["*", "read", "edit", "bash", "webfetch", "task"]) {
      expect(names.has(permission), `${permission} was not sent`).toBe(true)
    }
    // Catch-all first: `Permission.evaluate` takes the LAST match, so a trailing `*`
    // would override every grant before it.
    expect(sent[0]).toEqual({ permission: "*", pattern: "*", action: "ask" })
  })

  // The client is already scoped to a directory, so sending one would be redundant
  // and would add directory-string routing debt. The existing session.update call
  // site (title editing) passes none either.
  test("sends no directory — the client is already scoped to one", async () => {
    const { client, calls } = writer()
    await applyPermissionMode({ delivery: permissive("opencode").delivery, sessionID: "ses_1", client })
    expect("directory" in calls[0]!).toBe(false)
  })

  // A failed write must reach the caller. Swallowing it would leave the picker
  // showing a mode the engine never received.
  test("propagates a failed write instead of reporting success", async () => {
    const client: SessionPermissionWriter = {
      session: {
        update: async () => {
          throw new Error("503 instance unavailable")
        },
      },
    }
    await expect(
      applyPermissionMode({ delivery: permissive("opencode").delivery, sessionID: "ses_1", client }),
    ).rejects.toThrow("503")
  })
})

describe("applyPermissionMode — the other deliveries", () => {
  test("local answering sends nothing and says so", async () => {
    const { client, calls } = writer()
    // ACP and pi both resolve Auto to local answering.
    for (const harness of ["claude-acp", "codex-acp", "cursor-acp", "cursor-sdk", "pi"] as const) {
      const result = await applyPermissionMode({
        delivery: permissive(harness).delivery,
        sessionID: "ses_1",
        client,
      })
      expect(result, harness).toEqual({ kind: "answered-locally" })
    }
    expect(calls).toHaveLength(0)
  })

  // The harness delivery forwards an id the harness itself supplied. It reports
  // what the harness KEPT, which can differ from the request — an ACP agent clamps
  // its mode when a model change shrinks the available set, and a client that
  // echoed its own request would drift from reality without ever noticing.
  test("a harness mode is forwarded and the harness's own answer is returned", async () => {
    const sent: { sessionID: string; modeId: string }[] = []
    const client: SessionPermissionWriter = {
      session: { update: async () => ({}) },
      setPermissionMode: async (input) => {
        sent.push(input)
        return { currentModeId: "clamped-to-something-else" }
      },
    }
    const result = await applyPermissionMode({
      delivery: { kind: "harness-permission-mode", modeId: "full-access", appliesFrom: "next-turn" },
      sessionID: "ses_1",
      client,
    })
    expect(sent).toEqual([{ sessionID: "ses_1", modeId: "full-access" }])
    expect(result).toEqual({ kind: "applied", appliesFrom: "next-turn", kept: "clamped-to-something-else" })
  })

  // `next-session` survives the round trip rather than being flattened. On cursor
  // this is the difference between "from your next message" and "not this session
  // at all".
  test("next-session is carried through, not normalised to next-turn", async () => {
    const client: SessionPermissionWriter = {
      session: { update: async () => ({}) },
      setPermissionMode: async () => ({ currentModeId: "auto-review" }),
    }
    const result = await applyPermissionMode({
      delivery: { kind: "harness-permission-mode", modeId: "auto-review", appliesFrom: "next-session" },
      sessionID: "ses_1",
      client,
    })
    expect(result.kind === "applied" && result.appliesFrom).toBe("next-session")
  })

  // A client with no route to the harness (a cloud opencode session talks to the
  // opencode client, which has no such method) must say not-wired rather than
  // throwing or silently succeeding.
  test("no route to the harness reports not-wired", async () => {
    const { client } = writer()
    const result = await applyPermissionMode({
      delivery: { kind: "harness-permission-mode", modeId: "auto", appliesFrom: "next-turn" },
      sessionID: "ses_1",
      client,
    })
    expect(result).toEqual({ kind: "not-wired", delivery: "harness-permission-mode" })
  })
})

describe("permissionModeDeliverable stays pinned to applyPermissionMode", () => {
  // The drift guard. A picker asks `permissionModeDeliverable` whether an option is
  // selectable; `applyPermissionMode` decides what actually happens. If someone
  // implements a delivery and forgets to flip the predicate, the mode stays greyed
  // out for no reason. If someone flips the predicate without implementing the
  // delivery, the picker offers a mode that silently does nothing — the exact
  // failure `not-wired` exists to expose. Walk every kind and require agreement.
  const ALL: PermissionModeDelivery[] = [
    permissive("opencode").delivery,
    permissive("pi").delivery,
    { kind: "harness-permission-mode", modeId: "auto", appliesFrom: "next-turn" },
  ]

  test("every delivery kind is covered by this table", () => {
    const kinds = new Set(ALL.map((delivery) => delivery.kind))
    // If a new delivery kind is added, this fails until it is listed above — which
    // is what stops the guard silently covering less than it claims.
    expect(kinds).toEqual(new Set(["opencode-session-ruleset", "claxedo-auto-answer", "harness-permission-mode"]))
  })

  test("deliverable exactly when applyPermissionMode does not report not-wired", async () => {
    // A client that CAN reach the harness, so `not-wired` here can only come from
    // an unimplemented delivery rather than from a missing route.
    const client: SessionPermissionWriter = {
      session: { update: async () => ({}) },
      setPermissionMode: async () => ({ currentModeId: "auto" }),
    }
    for (const delivery of ALL) {
      const result = await applyPermissionMode({ delivery, sessionID: "ses_1", client })
      const actuallyDelivered = result.kind !== "not-wired"
      expect(permissionModeDeliverable(delivery.kind), delivery.kind).toBe(actuallyDelivered)
    }
  })
})
