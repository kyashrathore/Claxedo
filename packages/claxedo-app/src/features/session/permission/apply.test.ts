import { describe, expect, test } from "bun:test"
import { applyPermissionMode, permissionModeDeliverable, type SessionPermissionWriter } from "./apply"
import { claxedoAutoMode, type PermissionModeDelivery } from "./modes"

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
      delivery: claxedoAutoMode("opencode").delivery,
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
      delivery: claxedoAutoMode("opencode").delivery,
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
    await applyPermissionMode({ delivery: claxedoAutoMode("opencode").delivery, sessionID: "ses_1", client })
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
      applyPermissionMode({ delivery: claxedoAutoMode("opencode").delivery, sessionID: "ses_1", client }),
    ).rejects.toThrow("503")
  })
})

describe("applyPermissionMode — the other deliveries", () => {
  test("local answering sends nothing and says so", async () => {
    const { client, calls } = writer()
    // ACP and pi both resolve Auto to local answering.
    for (const harness of ["claude-acp", "codex-acp", "cursor-acp", "cursor-sdk", "pi"] as const) {
      const result = await applyPermissionMode({
        delivery: claxedoAutoMode(harness).delivery,
        sessionID: "ses_1",
        client,
      })
      expect(result, harness).toEqual({ kind: "answered-locally" })
    }
    expect(calls).toHaveLength(0)
  })

  // These are real deliveries with no implementation yet. They must report
  // `not-wired` rather than success, or a picker will claim a mode is active when
  // nothing was sent — the exact failure this module exists to prevent for opencode.
  test("unimplemented deliveries report not-wired, never applied", async () => {
    const { client, calls } = writer()
    const deliveries: PermissionModeDelivery[] = [
      { kind: "acp-set-session-mode", modeId: "plan" },
      { kind: "claude-sdk-permission-mode", permissionMode: "auto" },
      { kind: "codex-approval-policy", approvalPolicy: "on-request", sandbox: "workspace-write" },
    ]
    for (const delivery of deliveries) {
      const result = await applyPermissionMode({ delivery, sessionID: "ses_1", client })
      expect(result).toEqual({ kind: "not-wired", delivery: delivery.kind })
    }
    expect(calls).toHaveLength(0)
  })

  // Claude and Codex have native mechanisms, so Auto must NOT resolve to local
  // answering for them — that would silently downgrade an enforced policy to
  // Claxedo replying to prompts after the fact.
  test("Claude and Codex Auto are native deliveries, so they are not answered locally", async () => {
    const { client } = writer()
    for (const harness of ["claude-sdk", "codex-app-server"] as const) {
      const result = await applyPermissionMode({
        delivery: claxedoAutoMode(harness).delivery,
        sessionID: "ses_1",
        client,
      })
      expect(result.kind, harness).toBe("not-wired")
    }
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
    claxedoAutoMode("opencode").delivery,
    claxedoAutoMode("pi").delivery,
    { kind: "acp-set-session-mode", modeId: "plan" },
    { kind: "claude-sdk-permission-mode", permissionMode: "auto" },
    { kind: "codex-approval-policy", approvalPolicy: "on-request", sandbox: "workspace-write" },
  ]

  test("every delivery kind is covered by this table", () => {
    const kinds = new Set(ALL.map((delivery) => delivery.kind))
    // If a new delivery kind is added, this fails until it is listed above — which
    // is what stops the guard silently covering less than it claims.
    expect(kinds).toEqual(
      new Set([
        "opencode-session-ruleset",
        "claxedo-auto-answer",
        "acp-set-session-mode",
        "claude-sdk-permission-mode",
        "codex-approval-policy",
      ]),
    )
  })

  test("deliverable exactly when applyPermissionMode does not report not-wired", async () => {
    const client: SessionPermissionWriter = { session: { update: async () => ({}) } }
    for (const delivery of ALL) {
      const result = await applyPermissionMode({ delivery, sessionID: "ses_1", client })
      const actuallyDelivered = result.kind !== "not-wired"
      expect(permissionModeDeliverable(delivery.kind), delivery.kind).toBe(actuallyDelivered)
    }
  })
})
