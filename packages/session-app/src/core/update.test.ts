import { describe, expect, test } from "bun:test"
import { initSessionModel, type SessionModel } from "./model"
import { applyRuntimeEvent, decodeTranscript, update } from "./update"

function model(): SessionModel {
  return initSessionModel({ sessionId: "ses_1", directory: "/tmp/project" })
}

function fold(events: Array<{ type: string } & Record<string, unknown>>, from = model()) {
  return events.reduce((m, event) => applyRuntimeEvent(m, event), from)
}

describe("runtime-event fold", () => {
  test("a full streamed turn produces user-visible rows in order", () => {
    const m = fold([
      { type: "session-status", status: "busy" },
      { type: "step-start", newMessageId: "msg_1" },
      { type: "text-delta", delta: "Hello " },
      { type: "text-delta", delta: "world" },
      { type: "tool-start", toolCallId: "t1", toolName: "bash", display: { summary: "ls -la" } },
      { type: "tool-status", toolCallId: "t1", status: "completed" },
      { type: "finish", sessionId: "ses_1" },
    ])

    expect(m.status).toBe("idle")
    expect(m.rows).toMatchObject([
      { kind: "assistant", id: "msg_1", markdown: "Hello world", streaming: false },
      { kind: "tool", toolCallId: "t1", name: "bash", status: "completed", summary: "ls -la" },
    ])
  })

  test("a delta without step-start still renders (harnesses that stream immediately)", () => {
    const m = fold([{ type: "text-delta", delta: "hi" }])
    expect(m.rows).toMatchObject([{ kind: "assistant", markdown: "hi", streaming: true }])
  })

  test("thinking and assistant streams stay separate rows", () => {
    const m = fold([
      { type: "thinking-delta", delta: "let me think" },
      { type: "step-start", newMessageId: "msg_1" },
      { type: "text-delta", delta: "answer" },
    ])
    expect(m.rows.map((row) => row.kind)).toEqual(["thinking", "assistant"])
    expect(m.rows[1]).toMatchObject({ markdown: "answer" })
  })

  test("unknown event types return the model unchanged, by reference", () => {
    const before = fold([{ type: "text-delta", delta: "x" }])
    const after = applyRuntimeEvent(before, { type: "some-future-event", payload: 1 })
    expect(after).toBe(before)
  })

  test("a text-delta preserves the identity of every untouched row", () => {
    const before = fold([
      { type: "tool-start", toolCallId: "t1", toolName: "read" },
      { type: "step-start", newMessageId: "msg_1" },
      { type: "text-delta", delta: "a" },
    ])
    const after = applyRuntimeEvent(before, { type: "text-delta", delta: "b" })
    expect(after.rows[0]).toBe(before.rows[0])
    expect(after.rows[1]).not.toBe(before.rows[1])
    expect(after.rows[1]).toMatchObject({ markdown: "ab" })
  })

  test("todo-update and plan rows are singletons replaced in place", () => {
    const m = fold([
      { type: "todo-update", todos: [{ id: "1", description: "a", status: "pending" }] },
      { type: "proposed-plan-delta", delta: "step " },
      { type: "proposed-plan-delta", delta: "one" },
      { type: "todo-update", todos: [{ id: "1", description: "a", status: "completed" }] },
      { type: "proposed-plan-complete", planMarkdown: "step one, final" },
    ])
    expect(m.rows.filter((row) => row.kind === "todos")).toHaveLength(1)
    expect(m.rows.filter((row) => row.kind === "plan")).toHaveLength(1)
    expect(m.rows.find((row) => row.kind === "plan")).toMatchObject({ markdown: "step one, final", complete: true })
  })

  test("tool errors mark the tool row failed and keep the error", () => {
    const m = fold([
      { type: "tool-start", toolCallId: "t1", toolName: "bash" },
      { type: "tool-error", toolCallId: "t1", error: "exit 1" },
    ])
    expect(m.rows[0]).toMatchObject({ kind: "tool", status: "failed", error: "exit 1" })
  })
})

describe("update", () => {
  test("submit trims, appends the user row, clears the draft, and emits the effect", () => {
    const drafted = update(model(), { type: "DraftEdited", text: "  run the tests  " }).model
    const { model: m, effects } = update(drafted, { type: "SubmitPrompt" })

    expect(m.draft).toBe("")
    expect(m.sending).toBe(true)
    expect(m.rows).toMatchObject([{ kind: "user", text: "run the tests" }])
    expect(effects).toEqual([{ kind: "send-prompt", sessionId: "ses_1", directory: "/tmp/project", text: "run the tests" }])
  })

  test("an empty or in-flight submit is a no-op", () => {
    expect(update(model(), { type: "SubmitPrompt" }).effects).toEqual([])
    const inFlight = { ...model(), draft: "x", sending: true }
    expect(update(inFlight, { type: "SubmitPrompt" }).effects).toEqual([])
  })

  test("a failed prompt surfaces as an error notice and unblocks the composer", () => {
    const sending = { ...model(), sending: true }
    const m = update(sending, { type: "PromptFailed", error: "connection refused" }).model
    expect(m.sending).toBe(false)
    expect(m.rows.at(-1)).toMatchObject({ kind: "notice", severity: "error", message: "connection refused" })
  })
})

describe("composer: load flows", () => {
  test("ComposerOpened emits the load effects for roster, workspaces and worktrees", () => {
    const initial = model()
    const { model: m, effects } = update(initial, { type: "ComposerOpened" })
    expect(m).toBe(initial) // no state change yet — loads report back as messages
    expect(effects).toEqual([
      { kind: "load-roster", directory: "/tmp/project" },
      { kind: "load-workspaces" },
      { kind: "load-worktrees", directory: "/tmp/project" },
    ])
  })

  test("RosterLoaded auto-selects the active harness and loads its models and modes", () => {
    const { model: m, effects } = update(model(), {
      type: "RosterLoaded",
      harnesses: [
        { id: "opencode", name: "OpenCode" },
        { id: "claude-acp", name: "Claude", active: true },
      ],
    })
    expect(m.composer.selectedHarness).toBe("claude-acp")
    expect(m.composer.harnesses).toHaveLength(2)
    expect(effects).toEqual([
      { kind: "load-models", directory: "/tmp/project", harness: "claude-acp" },
      { kind: "load-modes", directory: "/tmp/project", harness: "claude-acp" },
    ])
  })

  test("RosterLoaded never overrides an existing harness selection", () => {
    const chosen = update(model(), { type: "SelectHarness", harness: "codex-acp" }).model
    const { model: m, effects } = update(chosen, {
      type: "RosterLoaded",
      harnesses: [{ id: "claude-acp", name: "Claude", active: true }],
    })
    expect(m.composer.selectedHarness).toBe("codex-acp")
    expect(effects).toEqual([])
  })

  test("ModelsLoaded fills models+efforts and picks the default model", () => {
    const chosen = update(model(), { type: "SelectHarness", harness: "claude-acp" }).model
    const m = update(chosen, {
      type: "ModelsLoaded",
      harness: "claude-acp",
      models: [
        { providerID: "claude-acp", modelID: "opus", name: "Opus" },
        { providerID: "claude-acp", modelID: "sonnet", name: "Sonnet" },
      ],
      efforts: [{ id: "default", name: "Default" }, { id: "high", name: "High" }],
      defaultModel: { providerID: "claude-acp", modelID: "sonnet" },
    }).model
    expect(m.composer.selectedModel).toEqual({ providerID: "claude-acp", modelID: "sonnet" })
    expect(m.composer.models).toHaveLength(2)
    expect(m.composer.efforts).toHaveLength(2)
  })

  test("a stale ModelsLoaded for a harness no longer selected is dropped, by reference", () => {
    const chosen = update(model(), { type: "SelectHarness", harness: "codex-acp" }).model
    const result = update(chosen, {
      type: "ModelsLoaded",
      harness: "claude-acp",
      models: [{ providerID: "claude-acp", modelID: "opus", name: "Opus" }],
    })
    expect(result.model).toBe(chosen)
    expect(result.effects).toEqual([])
  })

  test("ModesLoaded keeps a still-valid selection, else falls to the harness's current mode", () => {
    const chosen = update(model(), { type: "SelectHarness", harness: "claude-acp" }).model
    const loaded = update(chosen, {
      type: "ModesLoaded",
      harness: "claude-acp",
      modes: [{ id: "default", name: "Manual", level: "ask" }, { id: "plan", name: "Plan Mode" }],
      currentModeId: "default",
    }).model
    expect(loaded.composer.selectedMode).toBe("default")

    const picked = update(loaded, { type: "SelectMode", modeId: "plan" }).model
    const reloaded = update(picked, {
      type: "ModesLoaded",
      harness: "claude-acp",
      modes: [{ id: "default", name: "Manual" }, { id: "plan", name: "Plan Mode" }],
      currentModeId: "default",
    }).model
    expect(reloaded.composer.selectedMode).toBe("plan")
  })

  test("ModesLoaded records the unsupported marker (opencode has no modes)", () => {
    const chosen = update(model(), { type: "SelectHarness", harness: "opencode" }).model
    const m = update(chosen, {
      type: "ModesLoaded",
      harness: "opencode",
      modes: [],
      unsupported: "opencode has no permission modes of its own",
    }).model
    expect(m.composer.permissionModes).toEqual([])
    expect(m.composer.modesUnsupported).toBe("opencode has no permission modes of its own")
  })

  test("WorkspacesLoaded stores cloud and local workspaces", () => {
    const m = update(model(), {
      type: "WorkspacesLoaded",
      workspaces: [
        { workspaceId: "w1", directory: "/tmp/project", access: "local" },
        { workspaceId: "w2", directory: "/workspace", access: "cloud", name: "Cloudy" },
      ],
    }).model
    expect(m.composer.workspaces.map((w) => w.access)).toEqual(["local", "cloud"])
  })

  test("composer messages never touch the timeline rows, by reference", () => {
    const withRows = update(model(), { type: "TranscriptLoaded", messages: [{ id: "m1", role: "user", text: "hi" }] }).model
    const m = update(withRows, { type: "RosterLoaded", harnesses: [{ id: "opencode", name: "OpenCode" }] }).model
    expect(m.rows).toBe(withRows.rows)
  })
})

describe("composer: selection flows", () => {
  test("SelectHarness clears harness-scoped state and reloads models+modes", () => {
    const chosen = update(model(), { type: "SelectHarness", harness: "claude-acp" }).model
    const loaded = update(chosen, {
      type: "ModelsLoaded",
      harness: "claude-acp",
      models: [{ providerID: "claude-acp", modelID: "opus", name: "Opus" }],
      efforts: [{ id: "high", name: "High" }],
    }).model
    const { model: switched, effects } = update(loaded, { type: "SelectHarness", harness: "codex-acp" })
    expect(switched.composer).toMatchObject({
      selectedHarness: "codex-acp",
      models: [],
      efforts: [],
      permissionModes: [],
    })
    expect(switched.composer.selectedModel).toBeUndefined()
    expect(effects).toEqual([
      { kind: "load-models", directory: "/tmp/project", harness: "codex-acp" },
      { kind: "load-modes", directory: "/tmp/project", harness: "codex-acp" },
    ])
  })

  test("re-selecting the current harness/model/effort/mode is a no-op, by reference", () => {
    const chosen = update(model(), { type: "SelectHarness", harness: "claude-acp" }).model
    expect(update(chosen, { type: "SelectHarness", harness: "claude-acp" }).model).toBe(chosen)
    const modeled = update(chosen, { type: "SelectModel", model: { providerID: "claude-acp", modelID: "opus" } }).model
    expect(update(modeled, { type: "SelectModel", model: { providerID: "claude-acp", modelID: "opus" } }).model).toBe(modeled)
  })

  test("SelectWorkspace switches project, clears worktrees, and reloads them", () => {
    const { model: m, effects } = update(model(), { type: "SelectWorkspace", directory: "/tmp/other" })
    expect(m.composer.selectedWorkspace).toBe("/tmp/other")
    expect(m.composer.worktrees).toEqual([])
    expect(m.composer.selectedWorktree).toBeUndefined()
    expect(effects).toEqual([{ kind: "load-worktrees", directory: "/tmp/other" }])
  })

  test("WorktreesLoaded lands only for the currently selected project", () => {
    const switched = update(model(), { type: "SelectWorkspace", directory: "/tmp/other" }).model
    const stale = update(switched, { type: "WorktreesLoaded", directory: "/tmp/project", worktrees: ["/x"] })
    expect(stale.model).toBe(switched)
    const fresh = update(switched, { type: "WorktreesLoaded", directory: "/tmp/other", worktrees: ["/data/wt/a"] }).model
    expect(fresh.composer.worktrees).toEqual(["/data/wt/a"])
  })

  test("CreateWorktree emits the effect once and WorktreeCreated selects the new worktree", () => {
    const { model: creating, effects } = update(model(), { type: "CreateWorktree", name: "probe" })
    expect(creating.composer.creatingWorktree).toBe(true)
    expect(effects).toEqual([{ kind: "create-worktree", directory: "/tmp/project", name: "probe" }])
    // A second create while one is in flight is refused.
    expect(update(creating, { type: "CreateWorktree", name: "again" }).effects).toEqual([])

    const done = update(creating, {
      type: "WorktreeCreated",
      worktree: { name: "probe", branch: "opencode/probe", directory: "/data/wt/probe" },
    }).model
    expect(done.composer.creatingWorktree).toBe(false)
    expect(done.composer.worktrees).toEqual(["/data/wt/probe"])
    expect(done.composer.selectedWorktree).toBe("/data/wt/probe")
  })

  test("a failed worktree create unblocks and records the error", () => {
    const creating = update(model(), { type: "CreateWorktree" }).model
    const m = update(creating, { type: "ComposerLoadFailed", resource: "worktree-create", error: "no commits yet" }).model
    expect(m.composer.creatingWorktree).toBe(false)
    expect(m.composer.lastError).toBe("worktree-create: no commits yet")
  })
})

describe("composer: submit carries the full selection", () => {
  test("send-prompt includes model, variant and permissionMode from the composer", () => {
    let m = model()
    m = update(m, { type: "SelectHarness", harness: "claude-acp" }).model
    m = update(m, { type: "SelectModel", model: { providerID: "claude-acp", modelID: "opus" } }).model
    m = update(m, { type: "SelectEffort", effort: "high" }).model
    m = update(m, { type: "SelectMode", modeId: "plan" }).model
    m = update(m, { type: "DraftEdited", text: "go" }).model

    const { effects } = update(m, { type: "SubmitPrompt" })
    expect(effects).toEqual([{
      kind: "send-prompt",
      sessionId: "ses_1",
      directory: "/tmp/project",
      text: "go",
      model: { providerID: "claude-acp", modelID: "opus" },
      variant: "high",
      permissionMode: "plan",
    }])
  })

  test("with no selection the effect stays exactly the legacy shape", () => {
    const drafted = update(model(), { type: "DraftEdited", text: "hi" }).model
    const { effects } = update(drafted, { type: "SubmitPrompt" })
    expect(effects).toEqual([{ kind: "send-prompt", sessionId: "ses_1", directory: "/tmp/project", text: "hi" }])
  })
})

describe("transcript decoding", () => {
  test("decodes {info, parts} records tolerantly and drops what it cannot read", () => {
    const messages = decodeTranscript([
      { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
      { info: { id: "m2", role: "assistant" }, parts: [{ type: "text", text: "hello " }, { type: "text", text: "there" }, { type: "tool", weird: true }] },
      { info: { id: "m3", role: "system" }, parts: [] },
      "garbage",
      { parts: [{ type: "text", text: "no info" }] },
    ])

    expect(messages).toEqual([
      { id: "m1", role: "user", text: "hi" },
      { id: "m2", role: "assistant", text: "hello there" },
    ])
  })
})
