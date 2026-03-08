import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createTerminalPanelSplit } from "./split"

describe("createTerminalPanelSplit", () => {
  test("split watcher binds arriving PTY into the target pane", async () => {
    const calls: Array<{ op: string; id?: string; at?: string; dir?: string }> = []
    let dispose = () => {}

    createRoot((d) => {
      dispose = d
      const [ptys, setPtys] = createSignal([{ id: "pty-root" }])
      const split = createTerminalPanelSplit({
        claxedo: {
          terminal: {
            ids: () => ["pty-root"],
            ensure: (_tabId: string, id: string) => calls.push({ op: "ensure", id }),
            own: (_tabId: string, id: string) => calls.push({ op: "own", id }),
            splitInTab: (input: { at: string; id: string; dir: "h" | "v" }) =>
              calls.push({ op: "split", id: input.id, at: input.at, dir: input.dir }),
          },
        } as any,
        terminal: { new: () => {} } as any,
        ptys,
        tabId: "tab-1",
        log: () => {},
        resolveLiveFocus: () => "pty-root",
        terminalOrigin: () => ({ tabId: "tab-1", groupId: "g-default", hostId: "claxedo-tab-host-tab-1" }),
      })

      split.splitFor("v", "pty-root")
      setPtys([{ id: "pty-root" }, { id: "pty-new" }])
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    dispose()

    expect(calls).toContainEqual({ op: "ensure", id: "pty-root" })
    expect(calls).toContainEqual({ op: "own", id: "pty-new" })
    expect(calls).toContainEqual({ op: "split", id: "pty-new", at: "pty-root", dir: "v" })
  })
})
