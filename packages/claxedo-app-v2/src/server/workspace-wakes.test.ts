/// <reference types="bun" />
import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { placementId } from "./ids"
import type { Placement } from "./types"
import type { RuntimeRoute, Transport } from "./transport"
import type { StartOptions } from "./workspace-start"
import { createWorkspaceWakes } from "./workspace-wakes"
import type { Workspaces } from "./workspaces"

const cloud = placementId("ws_cloud")
const folder = placementId("ws_folder")

function fixture(running: { value: boolean }) {
  const starts: string[] = []
  let finish: () => void = () => undefined
  const placements: Record<string, Placement> = {
    ws_cloud: { id: cloud, projectId: "proj" as Placement["projectId"], kind: "cloud", label: "main", reachable: running.value },
    ws_folder: { id: folder, projectId: "proj" as Placement["projectId"], kind: "folder", label: "repo", reachable: false },
  }
  const transport = {
    startRuntime: (workspaceId: string, options?: StartOptions) => {
      starts.push(workspaceId)
      options?.onProgress?.({ kind: "provisioning", bootMode: "resume" })
      return new Promise<void>((resolve) => (finish = resolve))
    },
  } as Pick<Transport, "startRuntime"> as Transport
  const workspaces = {
    load: async () => ({ declaration: { hostAggregate: false, issuesSessions: true, documents: false }, placements: [] }),
    byId: (id: string) => ({ ...placements[id]!, reachable: id === "ws_cloud" ? running.value : false }),
    locate: async (id: string): Promise<RuntimeRoute> => ({ directory: `workspace:${id}`, workspaceId: id, remote: true }),
    refresh: async () => undefined,
  } as Pick<Workspaces, "load" | "byId" | "locate" | "refresh"> as Workspaces
  return { starts, finish: () => finish(), wakes: createRoot(() => createWorkspaceWakes(transport, workspaces)) }
}

async function settle() {
  for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
}

test("wakes: a send to a stopped cloud workspace starts it once, however many sends wait on it, and reports the boot while it wakes", async () => {
  const running = { value: false }
  const { starts, finish, wakes } = fixture(running)

  const first = wakes.wakeIfStopped(cloud)
  const second = wakes.wakeIfStopped(cloud)
  await settle()
  expect(starts).toEqual(["ws_cloud"])
  expect(wakes.waking(cloud)).toEqual({ kind: "provisioning", bootMode: "resume" })

  running.value = true
  finish()
  await Promise.all([first, second])
  expect(wakes.waking(cloud)).toBeUndefined()
})

test("wakes: a running workspace, or a placement that is not in the cloud, is never started by a send", async () => {
  const running = { value: true }
  const { starts, wakes } = fixture(running)

  await wakes.wakeIfStopped(cloud)
  await wakes.wakeIfStopped(folder)
  expect(starts).toEqual([])
})
