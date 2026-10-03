/// <reference types="bun" />
import { afterEach, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import type { Server } from "./api"
import { localFileContentQuery } from "./files"
import { machineId, placementId, projectId } from "./ids"

const placement = { id: placementId("p1"), projectId: projectId("j1"), kind: "folder", label: "work", machineId: machineId("m1"), reachable: true }
const server = {
  placements: { byId: () => placement },
  capabilities: () => ({ thisMachine: { id: machineId("m1") } }),
} as unknown as Pick<Server, "placements" | "capabilities">

function installBridge(readFileContent: unknown): void {
  const method = () => Promise.resolve()
  Object.assign(globalThis, { api: { openLink: method, openPath: method, renderMermaid: method, getWindowFullscreen: method, onFullscreenChange: method, readFileContent } })
}

const read = () => new QueryClient({ defaultOptions: { queries: { retry: false } } }).fetchQuery(localFileContentQuery(server, placementId("p1"), "/abs/a.ts"))

afterEach(() => Reflect.deleteProperty(globalThis, "api"))

test("a desktop file read answers only content the file contract admits", async () => {
  installBridge(async () => ({ type: "text", content: "hello", extra: true }))
  expect(await read()).toEqual({ type: "text", content: "hello" })
  installBridge(async () => ({ type: "image", content: "" }))
  await expect(read()).rejects.toThrow("The file content answer does not match its contract")
})

test("a preload without the file reader is not a desktop bridge", async () => {
  installBridge(undefined)
  await expect(read()).rejects.toThrow("This file cannot be opened on this computer.")
})
