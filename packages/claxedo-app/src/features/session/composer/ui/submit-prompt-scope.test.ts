import { describe, expect, test } from "bun:test"
import { sessionViewKey } from "@/platform/identity/session-view-key"
import { capturePromptSubmitScope, promptScopeKey, promptViewScope, uniquePromptScopes } from "./submit-prompt-scope"

// The composer reads its draft through `PromptProvider.session()`, which keys the
// prompt cache/persist on `sessionViewKey({ directory, sessionId, draftId })`.
// The submit path clears that draft with `prompt.reset(promptViewScope({
// directory, sessionId, draftId }))`, which resolves its key through `pick` ==
// `promptScopeKey`.
//
// Property under test: for ANY directory / sessionId / mode, the key the
// clear-after-send path targets is byte-identical to the key the composer reads.
// If they drift, the just-sent text stays in the composer and ArrowUp history
// recall (which requires an empty composer) is dead.
const composerReadKey = (directory?: string, sessionId?: string, draftId?: string) =>
  sessionViewKey({ directory, sessionId, draftId })
const submitClearKey = (directory?: string, sessionId?: string, draftId?: string) =>
  promptScopeKey(promptViewScope({ directory, sessionId, draftId }))

describe("prompt submit/clear scope derivation", () => {
  test("clear target matches the exact new-session draft surface", () => {
    expect(submitClearKey("/proj/alpha", "new", "draft-a")).toBe(
      composerReadKey("/proj/alpha", "new", "draft-a"),
    )
    expect(submitClearKey("/proj/alpha", "new", "draft-a")).not.toBe(
      submitClearKey("/proj/alpha", "new", "draft-b"),
    )
  })

  const cases: Array<{ name: string; directory?: string; sessionId?: string }> = [
    { name: "new draft (sessionId 'new')", directory: "/proj/alpha", sessionId: "new" },
    { name: "new draft (sessionId undefined)", directory: "/proj/alpha", sessionId: undefined },
    { name: "existing session", directory: "/proj/alpha", sessionId: "ses_123" },
    { name: "different workspace directory", directory: "/proj/beta", sessionId: "ses_456" },
    { name: "path needing url-encoding", directory: "/proj/a b+c/main", sessionId: "ses_789" },
    { name: "no directory", directory: undefined, sessionId: "ses_999" },
  ]

  for (const { name, directory, sessionId } of cases) {
    test(`clear target == composer read target — ${name}`, () => {
      expect(submitClearKey(directory, sessionId)).toBe(composerReadKey(directory, sessionId))
    })
  }

  test("promptViewScope carries the RAW directory + session id (pick applies sessionViewKey exactly once)", () => {
    // A scope must NOT pre-compute sessionViewKey; pick/promptScopeKey applies it.
    expect(promptViewScope({ directory: "/proj/alpha", sessionId: "ses_1" })).toEqual({
      dir: "/proj/alpha",
      id: "ses_1",
    })
    // Applying the derivation twice (the double-wrap regression) must NOT equal a
    // single application — this pins that promptScopeKey is applied exactly once.
    const raw = promptViewScope({ directory: "/proj/alpha", sessionId: "ses_1" })
    const once = promptScopeKey(raw)
    const twice = promptScopeKey({ dir: once })
    expect(twice).not.toBe(once)
  })



  test("uniquePromptScopes dedupes on raw dir+id and keeps the draft vs new-session split", () => {
    const draft = promptViewScope({ directory: "/proj/alpha", sessionId: "new" })
    const created = promptViewScope({ directory: "/proj/alpha", sessionId: "ses_new" })
    const scopes = uniquePromptScopes([draft, draft, created, undefined])
    expect(scopes).toEqual([draft, created])
    // The two distinct scopes must resolve to DIFFERENT persist keys so both the
    // draft slot and the freshly-created-session slot get reset.
    expect(promptScopeKey(scopes[0])).not.toBe(promptScopeKey(scopes[1]))
  })

  test("uniquePromptScopes keeps separate new-session draft surfaces", () => {
    const draftA = promptViewScope({ directory: "/proj/alpha", sessionId: "new", draftId: "draft-a" })
    const draftB = promptViewScope({ directory: "/proj/alpha", sessionId: "new", draftId: "draft-b" })

    expect(uniquePromptScopes([draftA, draftB, draftA])).toEqual([draftA, draftB])
  })
})

test("submission captures draft identity separately from its transport and mounted conversation", () => {
  let draftId = "draft-a"
  let directory = "/mounted/a"
  const captured = capturePromptSubmitScope({
    sessionDirectory: () => "ws_remote",
    conversationDirectory: () => directory,
    sessionID: () => "new",
    draftId: () => draftId,
  }, "/sdk")
  draftId = "draft-b"
  directory = "/mounted/b"
  expect(captured).toEqual({
    projectDirectory: "ws_remote", mountedConversationDirectory: "/mounted/a",
    explicitSessionID: "new", draftId: "draft-a", fallbackDirectory: undefined,
  })
})
