import { describe, expect, mock, test } from "bun:test"
import { createRoot, createSignal, getOwner } from "solid-js"
import type { WorkspaceRuntime, WorkspaceStartRun } from "@/server"
import type { BindingScope } from "./services"

await mock.module("@/cloud", () => ({
  useWakeProgress: (runtime: () => WorkspaceRuntime) => () => {
    const current = runtime()
    return current.kind === "waking" ? `Starting, ${current.steps?.done.length ?? 0} steps done` : undefined
  },
}))
await mock.module("../i18n", () => ({ usePluginsText: () => (key: string) => key }))
const { workspacesBinding } = await import("./workspaces")

function fixture(finish: (setRuntime: (runtime: WorkspaceRuntime) => void) => Promise<WorkspaceStartRun>) {
  const [runtime, setRuntime] = createSignal<WorkspaceRuntime>({ kind: "live" })
  const followed: string[] = []
  return createRoot((dispose) => {
    const cloud = {
      runtime: () => runtime(),
      followStart: async (id: string, following: () => void) => {
        followed.push(id)
        following()
        return finish(setRuntime)
      },
    }
    const scope = { services: { owner: getOwner(), server: { cloud } } } as unknown as BindingScope
    return { api: workspacesBinding(scope), followed, setRuntime, dispose }
  })
}

describe("plugin workspace bindings", () => {
  test("followStart reports each step of the start in the session screen's words, then that it runs, and stops reporting", async () => {
    const progress: (string | undefined)[] = []
    const { api, followed, setRuntime, dispose } = fixture(async (set) => {
      set({ kind: "waking", followed: true })
      set({ kind: "waking", followed: true, steps: { done: [], startedAt: 1, stepStartedAt: 1 } })
      set({ kind: "waking", followed: true, steps: { done: ["machine"], startedAt: 1, stepStartedAt: 2 } })
      set({ kind: "live" })
      return { kind: "running" }
    })
    expect(await api.followStart("ws_cloud", (text) => progress.push(text))).toEqual({ kind: "running" })
    setRuntime({ kind: "waking" })
    expect(followed).toEqual(["ws_cloud"])
    expect(progress).toEqual(["Starting, 0 steps done", "Starting, 1 steps done", undefined])
    dispose()
  })

  test("a start that does not run answers failed with the server's reason", async () => {
    const reason = { class: "conflict", message: "The image has no runtime", retryable: false } as const
    const { api, dispose } = fixture(async () => ({ kind: "notRunning", error: reason }) as WorkspaceStartRun)
    expect(await api.followStart("ws_cloud", () => undefined)).toEqual({ kind: "failed", message: "The image has no runtime" })
    const silent = fixture(async () => ({ kind: "notRunning" }))
    expect(await silent.api.followStart("ws_cloud", () => undefined)).toEqual({ kind: "failed", message: "plugins.workspaces.startFailed" })
    silent.dispose()
    dispose()
  })
})
