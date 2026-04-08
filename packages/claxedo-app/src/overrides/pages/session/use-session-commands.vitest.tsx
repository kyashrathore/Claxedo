import { beforeEach, describe, expect, test, vi } from "vitest"
import { createRoot } from "solid-js"

let routeParams = { dir: "b64:/ws", id: "new" as string | undefined }
let registered: (() => any[]) | undefined
const addReviewCalls: Array<{ directory: string; sessionId: string; title: string }> = []
const setActiveCalls: string[] = []
const closeCalls: string[] = []

vi.mock("@solidjs/router", () => ({
  useNavigate: () => () => undefined,
  useParams: () => routeParams,
}))

vi.mock("@/context/command", () => ({
  useCommand: () => ({
    register: (_id: string, fn: () => any[]) => {
      registered = fn
    },
  }),
}))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({
    show: () => undefined,
  }),
}))

vi.mock("@/context/file", () => ({
  useFile: () => ({
    pathFromTab: () => undefined,
    selectedLines: () => undefined,
    get: () => undefined,
  }),
  selectionFromLines: (value: unknown) => value,
}))

vi.mock("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock("@/context/layout", () => ({
  useLayout: () => ({
    tabs: () => ({
      active: () => undefined,
      close: () => undefined,
    }),
    view: () => ({
      terminal: {
        toggle: () => undefined,
        open: () => undefined,
        close: () => undefined,
        opened: () => false,
      },
    }),
    fileTree: {
      toggle: () => undefined,
    },
    terminal: {
      height: () => 320,
    },
  }),
}))

vi.mock("@/context/local", () => ({
  useLocal: () => ({
    agent: {
      move: () => undefined,
    },
    model: {
      current: () => ({ id: "model-1", provider: { id: "provider-1" } }),
      variant: {
        cycle: () => undefined,
      },
    },
  }),
}))

vi.mock("@/context/permission", () => ({
  usePermission: () => ({
    permissionsEnabled: () => true,
    isAutoAccepting: () => false,
    isAutoAcceptingDirectory: () => false,
    toggleAutoAccept: () => undefined,
    toggleAutoAcceptDirectory: () => undefined,
  }),
}))

vi.mock("@/context/prompt", () => ({
  usePrompt: () => ({
    context: {
      add: () => undefined,
    },
    set: () => undefined,
    reset: () => undefined,
  }),
}))

vi.mock("@/context/sdk", () => ({
  useSDK: () => ({
    directory: "/ws",
    client: {
      session: {
        abort: async () => undefined,
        revert: async () => undefined,
        unrevert: async () => undefined,
        summarize: async () => undefined,
        share: async () => ({ data: { share: { url: "https://share" } } }),
        unshare: async () => undefined,
      },
    },
  }),
}))

vi.mock("@/context/sync", () => ({
  useSync: () => ({
    session: {
      get: (id: string) => (id === "s-real" ? { title: "Real Session" } : undefined),
    },
    data: {
      session_status: {},
      message: {},
      config: { share: "disabled" },
      part: {},
    },
  }),
}))

vi.mock("@/context/terminal", () => ({
  useTerminal: () => ({
    all: () => [],
    new: () => undefined,
  }),
}))

vi.mock("@/components/dialog-select-file", () => ({
  DialogSelectFile: () => null,
}))

vi.mock("@/components/dialog-select-model", () => ({
  DialogSelectModel: () => null,
}))

vi.mock("@/components/dialog-select-mcp", () => ({
  DialogSelectMcp: () => null,
}))

vi.mock("@/components/dialog-fork", () => ({
  DialogFork: () => null,
}))

vi.mock("@opencode-ai/ui/toast", () => ({
  showToast: () => undefined,
}))

vi.mock("@opencode-ai/util/array", () => ({
  findLast: <T,>(items: T[], pred: (item: T) => boolean) => {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      if (pred(items[i]!)) return items[i]
    }
    return undefined
  },
}))

vi.mock("@/utils/prompt", () => ({
  extractPromptFromParts: () => [],
}))

vi.mock("@opencode-ai/sdk/v2", () => ({
  UserMessage: class {},
}))

vi.mock("@opencode-ai/util/encode", () => ({
  base64Decode: (value: string) => (value.startsWith("b64:") ? value.slice(4) : value),
}))

vi.mock("@claxedo/claxedo-ui/context/claxedo-layout", () => ({
  useClaxedoLayout: () => ({
    split: {
      focusedId: () => "g-1",
    },
    groupTabs: () => ({
      active: () => ({
        id: "tab-real",
        type: "session",
        directory: "/ws",
        sessionId: "s-real",
        title: "Real Session",
      }),
      addReviewWorkspace: (directory: string, sessionId: string, title: string) => {
        addReviewCalls.push({ directory, sessionId, title })
        return "review-1"
      },
      setActive: (id: string) => {
        setActiveCalls.push(id)
      },
      close: (id: string) => {
        closeCalls.push(id)
      },
    }),
  }),
}))

vi.mock("../../../analytics/posthog", () => ({
  capture: () => undefined,
}))

import { useSessionCommands } from "./use-session-commands"

describe("useSessionCommands split-mode session resolution", () => {
  beforeEach(() => {
    routeParams = { dir: "b64:/ws", id: "new" }
    registered = undefined
    addReviewCalls.length = 0
    setActiveCalls.length = 0
    closeCalls.length = 0
  })

  test("review.toggle should use the live split session instead of the route's draft new session", () => {
    createRoot((dispose) => {
      useSessionCommands({
        activeMessage: () => undefined,
        showAllFiles: () => undefined,
        navigateMessageByOffset: () => undefined,
        setExpanded: () => undefined,
        setActiveMessage: () => undefined,
        focusInput: () => undefined,
      })

      const commands = registered?.() ?? []
      const cmd = commands.find((item) => item.id === "review.toggle")
      expect(cmd).toBeTruthy()

      cmd.onSelect()
      dispose()
    })

    expect(addReviewCalls).toEqual([
      { directory: "/ws", sessionId: "s-real", title: "Real Session" },
    ])
    expect(setActiveCalls).toEqual(["review-1"])
    expect(closeCalls).toEqual([])
  })
})
