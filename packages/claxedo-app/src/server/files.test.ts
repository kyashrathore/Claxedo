/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { fileQueries } from "./files"
import { machineId, placementId, projectId } from "./ids"
import type { Transport } from "./transport"
import type { Placement } from "./types"
import type { Workspaces } from "./workspaces"

const own: Placement = { id: placementId("p1"), projectId: projectId("j1"), kind: "folder", label: "work", path: "/work", machineId: machineId("m1"), reachable: true, onThisMachine: true }
const cloud: Placement = { id: placementId("ws_1"), projectId: projectId("j1"), kind: "cloud", label: "payments", path: "/workspace/repo", reachable: true, onThisMachine: false }

function installBridge(readFileContent: unknown): void {
  const method = () => Promise.resolve()
  Object.assign(globalThis, { api: { openLink: method, openPath: method, renderMermaid: method, getWindowFullscreen: method, onFullscreenChange: method, readFileContent } })
}

function files(placement: Placement) {
  const asked: string[] = []
  const transport = {
    serverUrl: "http://server.test",
    runtimeJson: async (_route: unknown, path: string) => {
      asked.push(path)
      return { type: "text", content: "from the runtime" }
    },
  } as unknown as Transport
  const workspaces = {
    byId: () => placement,
    route: async () => ({ directory: placement.path ?? "", workspaceId: placement.id, remote: !placement.onThisMachine }),
  } as unknown as Workspaces
  const queries = fileQueries(transport, workspaces)
  const read = (path: string) => new QueryClient({ defaultOptions: { queries: { retry: false } } }).fetchQuery(queries.content(placement.id, path))
  return { asked, read }
}

afterEach(() => Reflect.deleteProperty(globalThis, "api"))

test("an absolute path inside the workspace reads through the placement's runtime, on any placement", async () => {
  const remote = files(cloud)
  expect(await remote.read("/workspace/repo/src/a.ts")).toEqual({ type: "text", content: "from the runtime" })
  expect(remote.asked).toEqual(["/api/wr/file/content?path=src%2Fa.ts"])
})

test("a file outside the workspace reads through the desktop app only for its own machine's placement", async () => {
  const local = files(own)
  installBridge(async () => ({ type: "text", content: "hello", extra: true }))
  expect(await local.read("/abs/a.ts")).toEqual({ type: "text", content: "hello" })
  installBridge(async () => ({ type: "image", content: "" }))
  await expect(local.read("/abs/a.ts")).rejects.toThrow("The file content answer does not match its contract")
  expect(local.asked).toEqual([])
})

test("a file outside a cloud workspace is refused in words, desktop bridge or not", async () => {
  installBridge(async () => ({ type: "text", content: "never read" }))
  await expect(files(cloud).read("/etc/hosts")).rejects.toThrow("This file is outside the workspace, so it opens only in the desktop app on the machine that holds it.")
  installBridge(undefined)
  await expect(files(own).read("/abs/a.ts")).rejects.toThrow("This file is outside the workspace")
})
