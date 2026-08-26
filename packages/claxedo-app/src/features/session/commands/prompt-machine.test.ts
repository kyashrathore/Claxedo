import { describe, expect, test } from "bun:test"
import { createSignal, flush, latest } from "solid-js"

import { centralSessionRef } from "@/platform/identity/session-ref"
import { mountReactive } from "@/lib/test-support/reactive-root"
import {
  admitPromptSubmission,
  initialPromptMachineState,
  retryPromptSubmission,
  transitionPromptMachine,
  type PromptMachineEvent,
  type PromptMachineState,
  type PromptMachineTransition,
  type PromptSnapshot,
} from "./prompt-machine"

describe("prompt machine", () => {
  test("transition table is exhaustive and reviewed", () => {
    const table = Object.fromEntries(
      promptMachineStateFixtures().map((state) => [
        state.s,
        Object.fromEntries(
          promptMachineEventFixtures().map((event) => [
            event.t,
            describeTransition(
              transitionPromptMachine(state, event).next,
              transitionPromptMachine(state, event).effects,
            ),
          ]),
        ),
      ]),
    )

    expect(table).toEqual({
      draft: {
        ABORT: "draft:",
        CREATE_FAILED: "draft:",
        DISPATCHED: "draft:",
        PROVISIONED: "draft:",
        PROVISION_FAILED: "draft:",
        RECONCILED: "draft:",
        RETRY: "draft:",
        SEND_FAILED: "draft:",
        SESSION_CREATED: "draft:",
        SUBMIT: "preparing:resolveDraftTarget",
        TARGET_RESOLVED: "draft:",
      },
      preparing: {
        ABORT: "rolledBack:abortActivePrompt,restoreSnapshot",
        CREATE_FAILED: "preparing:",
        DISPATCHED: "preparing:",
        PROVISIONED: "creating:createOpencodeSession",
        PROVISION_FAILED: "rolledBack:restoreSnapshot",
        RECONCILED: "preparing:",
        RETRY: "preparing:",
        SEND_FAILED: "preparing:",
        SESSION_CREATED: "preparing:",
        SUBMIT: "preparing:",
        TARGET_RESOLVED: "creating:createOpencodeSession",
      },
      creating: {
        ABORT: "rolledBack:abortActivePrompt,restoreSnapshot",
        CREATE_FAILED: "rolledBack:restoreSnapshot",
        DISPATCHED: "creating:",
        PROVISIONED: "creating:",
        PROVISION_FAILED: "creating:",
        RECONCILED: "creating:",
        RETRY: "creating:",
        SEND_FAILED: "creating:",
        SESSION_CREATED:
          "inflight:recordPromptSubmission,preparePromptRequest,applyOptimisticPromptHandoff,sendPromptRequest",
        SUBMIT: "creating:",
        TARGET_RESOLVED: "creating:",
      },
      inflight: {
        ABORT: "rolledBack:abortActivePrompt,restoreSnapshot",
        CREATE_FAILED: "inflight:",
        DISPATCHED: "inflight:",
        PROVISIONED: "inflight:",
        PROVISION_FAILED: "inflight:",
        RECONCILED: "reconciled:",
        RETRY: "inflight:",
        SEND_FAILED: "rolledBack:rollbackPromptDispatch,restoreSnapshot",
        SESSION_CREATED: "inflight:",
        SUBMIT: "inflight:",
        TARGET_RESOLVED: "inflight:",
      },
      reconciled: {
        ABORT: "reconciled:",
        CREATE_FAILED: "reconciled:",
        DISPATCHED: "reconciled:",
        PROVISIONED: "reconciled:",
        PROVISION_FAILED: "reconciled:",
        RECONCILED: "reconciled:",
        RETRY: "reconciled:",
        SEND_FAILED: "reconciled:",
        SESSION_CREATED: "reconciled:",
        SUBMIT: "reconciled:",
        TARGET_RESOLVED: "reconciled:",
      },
      rolledBack: {
        ABORT: "rolledBack:",
        CREATE_FAILED: "rolledBack:",
        DISPATCHED: "rolledBack:",
        PROVISIONED: "rolledBack:",
        PROVISION_FAILED: "rolledBack:",
        RECONCILED: "rolledBack:",
        RETRY: "preparing:resolveDraftTarget",
        SEND_FAILED: "rolledBack:",
        SESSION_CREATED: "rolledBack:",
        SUBMIT: "rolledBack:",
        TARGET_RESOLVED: "rolledBack:",
      },
    })
  })

  test("empty submit while work is active emits abort without leaving idle", () => {
    const result = transitionPromptMachine(initialPromptMachineState(), {
      t: "SUBMIT",
      mode: existingSessionMode("ses_empty"),
      snapshot: snapshot({ bodyMd: "" }),
      working: true,
    })

    expect(result.next).toEqual(initialPromptMachineState())
    expect(result.effects.map((effect) => effect.name)).toEqual(["abortActivePrompt"])
  })

  test("existing-session submit skips creating and dispatches against the session", () => {
    const result = transitionPromptMachine(initialPromptMachineState(), {
      t: "SUBMIT",
      mode: existingSessionMode("ses_existing"),
      snapshot: snapshot({ messageID: "msg_existing" }),
    })

    expect(result.next).toEqual({
      s: "inflight",
      sessionId: "ses_existing",
      messageID: "msg_existing",
      snapshot: snapshot({ messageID: "msg_existing" }),
    })
    expect(result.effects.map((effect) => effect.name)).toEqual([
      "recordPromptSubmission",
      "preparePromptRequest",
      "applyOptimisticPromptHandoff",
      "sendPromptRequest",
    ])
  })

  test("harness draft submit enters creating via harness claim", () => {
    const result = transitionPromptMachine(initialPromptMachineState(), {
      t: "SUBMIT",
      mode: {
        kind: "draft",
        target: {
          worktree: "main",
          workspaceKind: "cloud",
          signedControlPlane: true,
          harness: { id: "claude-acp", binary: "claude" },
        },
      },
      snapshot: snapshot(),
    })

    expect(result.next.s).toBe("creating")
    if (result.next.s !== "creating") throw new Error("expected creating state")
    expect(result.next.via).toBe("harness-claim")
    expect(result.effects.map((effect) => effect.name)).toEqual(["claimHarnessSession"])
  })

  test("create failure rolls back once with the original snapshot retained", () => {
    const failed = transitionPromptMachine(
      {
        s: "creating",
        via: "opencode",
        snapshot: snapshot({ bodyMd: "ship it", comments: ["comment_a"] }),
        mode: {
          kind: "draft",
          target: { worktree: "main", workspaceKind: "local", signedControlPlane: false },
        },
      },
      { t: "CREATE_FAILED", err: new Error("no session") },
    )

    expect(failed.next).toEqual({
      s: "rolledBack",
      reason: "create-failed",
      snapshot: snapshot({ bodyMd: "ship it", comments: ["comment_a"] }),
      mode: {
        kind: "draft",
        target: { worktree: "main", workspaceKind: "local", signedControlPlane: false },
      },
      restored: true,
    })
    expect(failed.effects.map((effect) => effect.name)).toEqual(["restoreSnapshot"])

    const repeated = transitionPromptMachine(failed.next, { t: "CREATE_FAILED", err: new Error("late") })
    expect(repeated.next).toBe(failed.next)
    expect(repeated.effects).toEqual([])
  })

  test("send failure after abort does not resurrect inflight", () => {
    const aborted = transitionPromptMachine(
      {
        s: "inflight",
        sessionId: "ses_abort",
        messageID: "msg_abort",
        snapshot: snapshot({ bodyMd: "cancel me" }),
      },
      { t: "ABORT" },
    )

    const lateFailure = transitionPromptMachine(aborted.next, { t: "SEND_FAILED", err: new Error("late") })

    expect(aborted.next.s).toBe("rolledBack")
    expect(lateFailure.next).toBe(aborted.next)
    expect(lateFailure.effects).toEqual([])
  })

  test("retry from rolled back state reuses the original snapshot", () => {
    const rolledBack: PromptMachineState = {
      s: "rolledBack",
      reason: "send-failed",
      snapshot: snapshot({ bodyMd: "again", comments: ["ctx"] }),
      mode: {
        kind: "draft",
        target: { worktree: "main", workspaceKind: "local", signedControlPlane: false },
      },
      restored: true,
    }

    const result = retryPromptSubmission(rolledBack)

    expect(result.next).toEqual({
      s: "preparing",
      job: "resolve-target",
      snapshot: snapshot({ bodyMd: "again", comments: ["ctx"] }),
      mode: {
        kind: "draft",
        target: { worktree: "main", workspaceKind: "local", signedControlPlane: false },
      },
    })
    expect(result.effects.map((effect) => effect.name)).toEqual(["resolveDraftTarget"])
  })

  test("admission helper owns empty and attachment-only submit gating", () => {
    const mode = existingSessionMode("ses_admission")

    expect(
      admitPromptSubmission({
        mode,
        bodyMd: "   ",
        imageCount: 0,
        commentCount: 0,
        working: false,
      }),
    ).toBe("ignore")

    expect(
      admitPromptSubmission({
        mode,
        bodyMd: "   ",
        imageCount: 0,
        commentCount: 0,
        working: true,
      }),
    ).toBe("abort-active")

    expect(
      admitPromptSubmission({
        mode,
        bodyMd: "   ",
        imageCount: 1,
        commentCount: 0,
        working: false,
      }),
    ).toBe("admit")

    expect(
      admitPromptSubmission({
        mode,
        bodyMd: "",
        imageCount: 0,
        commentCount: 1,
        working: false,
      }),
    ).toBe("admit")
  })

  test("controller exposes one reactive machine state and runs transition effects", () => {
    const effects: string[] = []
    // The machine owns memos and effects, so it is built under a root; the
    // `submit`/`abort` calls below are the composer's, made with no owner on
    // the stack, which is also the only shape Solid 2's dev build allows for a
    // reactive write.
    const [machine, dispose] = mountReactive(() =>
      createPromptMachine({
        runEffect: (effect) => {
          effects.push(effect.name)
        },
      }),
    )

    try {
      flush()
      expect(machine.state()).toEqual(initialPromptMachineState())

      machine.submit({
        mode: existingSessionMode("ses_controller"),
        snapshot: snapshot({ messageID: "msg_controller" }),
      })

      flush()
      expect(machine.state()).toEqual({
        s: "inflight",
        sessionId: "ses_controller",
        messageID: "msg_controller",
        snapshot: snapshot({ messageID: "msg_controller" }),
      })
      expect(effects).toEqual([
        "recordPromptSubmission",
        "preparePromptRequest",
        "applyOptimisticPromptHandoff",
        "sendPromptRequest",
      ])

      machine.abort()
      flush()
      expect(machine.state()).toEqual({
        s: "rolledBack",
        reason: "aborted",
        snapshot: snapshot({ messageID: "msg_controller" }),
        restored: true,
      })
      expect(effects.slice(4)).toEqual(["abortActivePrompt", "restoreSnapshot"])
    } finally {
      dispose()
    }
  })
})

function existingSessionMode(sessionId: string) {
  return {
    kind: "session" as const,
    ref: centralSessionRef({ sessionId })!,
  }
}

function snapshot(input: Partial<PromptSnapshot> = {}): PromptSnapshot {
  return {
    bodyMd: "hello",
    comments: [],
    images: [],
    mode: "normal",
    messageID: "msg_1",
    ...input,
  }
}

function describeTransition(state: PromptMachineState, effects: readonly { name: string }[]) {
  return `${state.s}:${effects.map((effect) => effect.name).join(",")}`
}

function createPromptMachine(input?: {
  readonly runEffect?: (effect: PromptMachineTransition["effects"][number], transition: PromptMachineTransition) => void
}) {
  const [state, setState] = createSignal<PromptMachineState>(initialPromptMachineState())
  const dispatch = (event: PromptMachineEvent) => {
    // `latest`, not `state()`: a machine driver must transition from the state
    // its own previous dispatch produced, and Solid 2 stages signal writes until
    // the scheduler flushes — so two dispatches in one task would both start
    // from the pre-first-event state and the second would discard the first.
    const current = latest(state)
    const transition = transitionPromptMachine(current, event)
    if (transition.next !== current) setState(transition.next)
    for (const effect of transition.effects) input?.runEffect?.(effect, transition)
    return transition
  }

  return {
    state,
    dispatch,
    submit: (input: {
      readonly mode: ReturnType<typeof existingSessionMode>
      readonly snapshot: PromptSnapshot
      readonly working?: boolean
    }) =>
      dispatch({
        t: "SUBMIT",
        mode: input.mode,
        snapshot: input.snapshot,
        working: input.working,
      }),
    abort: () => dispatch({ t: "ABORT" }),
    retry: () => dispatch({ t: "RETRY" }),
  }
}

function promptMachineStateFixtures(): PromptMachineState[] {
  return [
    initialPromptMachineState(),
    {
      s: "preparing",
      job: "resolve-target",
      snapshot: fixtureSnapshot(),
      mode: fixtureDraftMode(),
    },
    {
      s: "creating",
      via: "opencode",
      snapshot: fixtureSnapshot(),
      mode: fixtureDraftMode(),
    },
    {
      s: "inflight",
      sessionId: "ses_fixture",
      messageID: "msg_fixture",
      snapshot: fixtureSnapshot(),
      mode: fixtureDraftMode(),
    },
    { s: "reconciled", sessionId: "ses_fixture" },
    {
      s: "rolledBack",
      reason: "send-failed",
      snapshot: fixtureSnapshot(),
      mode: fixtureDraftMode(),
      restored: true,
    },
  ]
}

function promptMachineEventFixtures(): PromptMachineEvent[] {
  return [
    { t: "ABORT" },
    { t: "CREATE_FAILED", err: new Error("fixture") },
    { t: "DISPATCHED" },
    { t: "PROVISIONED" },
    { t: "PROVISION_FAILED", err: new Error("fixture") },
    { t: "RECONCILED" },
    { t: "RETRY" },
    { t: "SEND_FAILED", err: new Error("fixture") },
    { t: "SESSION_CREATED", sessionId: "ses_created" },
    { t: "SUBMIT", mode: fixtureDraftMode(), snapshot: fixtureSnapshot() },
    { t: "TARGET_RESOLVED" },
  ]
}

function fixtureDraftMode() {
  return {
    kind: "draft" as const,
    target: { worktree: "main" as const, workspaceKind: "local" as const, signedControlPlane: false },
  }
}

function fixtureSnapshot(): PromptSnapshot {
  return {
    bodyMd: "hello",
    comments: [],
    images: [],
    mode: "normal",
    messageID: "msg_fixture",
  }
}
