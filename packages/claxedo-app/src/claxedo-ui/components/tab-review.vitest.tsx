import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { cleanup, render, waitFor } from "@solidjs/testing-library"

let sessionDiff = vi.fn()
let sessionReviewProps: any
const commentsAdd = vi.fn()
const commentsFocus = vi.fn(() => null)
const commentsSetFocus = vi.fn()
const promptContextAdd = vi.fn()

const syncState = {
  status: "ready",
  data: {
    message: {} as Record<string, any[]>,
    session_diff: {} as Record<string, any[]>,
    session_status: {} as Record<string, any>,
    todo: {} as Record<string, any[]>,
    question: {} as Record<string, any[]>,
    permission: {} as Record<string, any[]>,
  },
}

const syncApi = {
  ...syncState,
  set: vi.fn(),
  session: {
    sync: vi.fn(),
    todo: vi.fn(),
    diff: vi.fn(),
    get: vi.fn(() => ({ title: "Review Session" })),
  },
}

vi.mock("@opencode-ai/claxedo-app", () => ({
  useSync: () => syncApi,
  useFile: () => ({
    load: vi.fn(async () => undefined),
    get: vi.fn(() => ({ content: { content: "" } })),
  }),
  useComments: () => ({
    add: commentsAdd,
    all: vi.fn(() => []),
    clear: vi.fn(),
    focus: commentsFocus,
    setFocus: commentsSetFocus,
  }),
  useServer: () => ({
    healthy: () => true,
  }),
}))

vi.mock("@/context/sdk", () => ({
  useSDK: () => ({
    directory: "/ws",
    client: {
      session: {
        diff: sessionDiff,
      },
    },
    clientRoot: {},
  }),
}))

vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock("@/context/prompt", () => ({
  usePrompt: () => ({
    ready: () => true,
    context: {
      add: promptContextAdd,
    },
  }),
}))

vi.mock("@opencode-ai/ui/session-review", () => ({
  SessionReview: (props: any) => {
    sessionReviewProps = props
    return <div data-testid="session-review" />
  },
}))

vi.mock("@opencode-ai/ui/icon-button", () => ({
  IconButton: (props: any) => <button onClick={props.onClick}>{props.icon}</button>,
}))

vi.mock("@opencode-ai/ui/diff-changes", () => ({
  DiffChanges: () => <div data-testid="diff-changes" />,
}))

vi.mock("@opencode-ai/ui/tooltip", () => ({
  Tooltip: (props: any) => <>{props.children}</>,
}))

vi.mock("@opencode-ai/ui/session-turn", () => ({
  SessionTurn: () => <div data-testid="session-turn" />,
}))

vi.mock("./compact-prompt-dock", () => ({
  CompactPromptDock: () => <div data-testid="compact-dock" />,
}))

import { TabReview } from "./tab-review"

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  sessionReviewProps = undefined
  sessionDiff = vi.fn().mockResolvedValue({ data: [] })
  commentsAdd.mockReset()
  commentsAdd.mockReturnValue({ id: "comment_1" })
  commentsFocus.mockReset()
  commentsFocus.mockReturnValue(null)
  commentsSetFocus.mockReset()
  promptContextAdd.mockReset()
  syncApi.status = "ready"
  syncApi.data.message = {}
  syncApi.data.session_diff = {}
  syncApi.data.session_status = {}
  syncApi.data.todo = {}
  syncApi.data.question = {}
  syncApi.data.permission = {}
  syncApi.set.mockReset()
  syncApi.session.sync.mockReset()
  syncApi.session.todo.mockReset()
  syncApi.session.diff.mockReset()
  syncApi.session.get.mockClear()
})

describe("TabReview", () => {
  test("to-from mode passes fromRef and toRef to diff request", async () => {
    render(() => (
      <TabReview
        sessionId="ses_1"
        mode="to-from"
        fromRef="dev"
        toRef="HEAD"
      />
    ))

    await waitFor(() => {
      expect(sessionDiff).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionID: "ses_1",
          mode: "to-from",
          fromRef: "dev",
          toRef: "HEAD",
        }),
      )
    })
  })

  test("focusPath + focusVersion expands and focuses matching diff", async () => {
    syncApi.data.message = {
      ses_2: [
        {
          id: "msg-1",
          role: "user",
          summary: {
            diffs: [
              {
                file: "src/focused.ts",
                before: "",
                after: "one\\n",
                additions: 1,
                deletions: 0,
                status: "added",
              },
            ],
          },
        },
      ],
    }

    render(() => (
      <TabReview
        sessionId="ses_2"
        mode="session-turn"
        focusPath="src/focused.ts"
        focusVersion={1}
      />
    ))

    await waitFor(() => {
      expect(sessionReviewProps).toBeDefined()
      expect(sessionReviewProps.focusedFile).toBe("src/focused.ts")
      expect(sessionReviewProps.open).toEqual(["src/focused.ts"])
      expect(sessionReviewProps.diffs).toHaveLength(1)
    })

    expect(sessionDiff).not.toHaveBeenCalled()
  })

  test("line comment adds both comment store and prompt context", async () => {
    syncApi.data.message = {
      ses_3: [
        {
          id: "msg-1",
          role: "user",
          summary: {
            diffs: [
              {
                file: "src/commented.ts",
                before: "",
                after: "x\\n",
                additions: 1,
                deletions: 0,
                status: "added",
              },
            ],
          },
        },
      ],
    }

    render(() => (
      <TabReview
        sessionId="ses_3"
        mode="session-turn"
      />
    ))

    await waitFor(() => {
      expect(sessionReviewProps).toBeDefined()
    })

    sessionReviewProps.onLineComment({
      file: "src/commented.ts",
      selection: { start: 1, end: 1, side: "additions" },
      comment: "check this",
      preview: "x",
    })

    expect(commentsAdd).toHaveBeenCalledWith({
      file: "src/commented.ts",
      selection: { start: 1, end: 1, side: "additions" },
      comment: "check this",
    })
    expect(promptContextAdd).toHaveBeenCalledWith({
      type: "file",
      path: "src/commented.ts",
      selection: {
        startLine: 1,
        endLine: 1,
        startChar: 0,
        endChar: 0,
      },
      comment: "check this",
      commentID: "comment_1",
      commentOrigin: "review",
      preview: "x",
    })
  })
})
