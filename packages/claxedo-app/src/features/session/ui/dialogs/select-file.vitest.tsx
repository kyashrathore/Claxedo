import { For, createResource } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, render, waitFor } from "@solidjs/testing-library"

const state = vi.hoisted(() => ({
  resolveSessions: undefined as ((value: { data: never[] }) => void) | undefined,
}))

vi.mock("@opencode-ai/ui/context/dialog", () => ({
  useDialog: () => ({ close: () => undefined }),
}))

vi.mock("@opencode-ai/ui/dialog", () => ({
  Dialog: (props: { children?: unknown }) => <div>{props.children as never}</div>,
}))

vi.mock("@opencode-ai/ui/file-icon", () => ({ FileIcon: () => null }))
vi.mock("@opencode-ai/ui/keybind", () => ({ Keybind: () => null }))
vi.mock("@/ui/controls/claxedo-icon", () => ({ ClaxedoIcon: () => null }))

vi.mock("@opencode-ai/ui/list", () => ({
  List: (props: { items: (query: string) => Promise<Array<{ title: string }>> }) => {
    const [items] = createResource(
      () => props.items("docs/notes"),
      (pending) => pending,
    )
    return (
      <div>
        <For each={items() ?? []}>{(item) => <div>{item.title}</div>}</For>
      </div>
    )
  },
}))

vi.mock("@solidjs/router", () => ({ useNavigate: () => () => undefined }))
vi.mock("@tanstack/solid-query", () => ({ useQuery: () => ({ data: { home: "/home/test" } }) }))
vi.mock("@/platform/i18n/provider", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
vi.mock("@/platform/runtime/transport", () => ({
  centralTransportForServer: () => "remote",
  isLocalPersonalScope: () => true,
}))

vi.mock("@/features/session/app-ports", () => ({
  formatKeybind: (value: string) => value,
  useCommand: () => ({ options: [] }),
  useGlobalSDK: () => ({
    url: "https://control.example",
    client: {
      session: {
        list: () => new Promise((resolve) => {
          state.resolveSessions = resolve
        }),
      },
    },
  }),
  useShellQueryOptions: () => ({ path: () => ({}) }),
  useLayout: () => ({
    tabs: () => ({
      all: () => [],
      active: () => undefined,
      open: () => undefined,
      setActive: () => undefined,
    }),
    view: () => ({ reviewPanel: { opened: () => true, open: () => undefined } }),
    projects: { list: () => [{ worktree: "/repo", sandboxes: [] }] },
    fileTree: { setTab: () => undefined },
  }),
  useFile: () => ({
    pathFromTab: () => undefined,
    searchFiles: async () => ["docs/notes-primer.md"],
    tree: {
      children: () => [],
      state: () => ({ loaded: true }),
      list: async () => undefined,
    },
  }),
  useClaxedoState: () => {
    throw new Error("not in claxedo mode")
  },
}))

import { DialogSelectFile } from "./select-file"

afterEach(() => {
  state.resolveSessions?.({ data: [] })
  state.resolveSessions = undefined
  cleanup()
})

describe("DialogSelectFile", () => {
  test("shows a file match without waiting for cross-workspace session search", async () => {
    const view = render(() => <DialogSelectFile directory="/repo" />)

    await waitFor(() => expect(view.getByText("docs/notes-primer.md")).toBeTruthy())
    expect(state.resolveSessions).toBeTypeOf("function")
  })
})
