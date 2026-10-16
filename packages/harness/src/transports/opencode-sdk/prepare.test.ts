import { afterEach, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { takeEventLoopActivity } from "@claxedo/helpers/event-loop-activity"
import type { HarnessServices } from "../../contract"
import { removeTempRoot } from "../../test-support/temp-root"
import type { OpenCodeRuntime } from "./runtime"
import { OpenCodeSdkTransport } from "./transport"

const roots: string[] = []
const transports: OpenCodeSdkTransport[] = []

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.dispose()))
  for (const root of roots.splice(0)) await removeTempRoot(root)
})

test("prepare boots the engine and activates the folder before any read asks for it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-prepare-"))
  roots.push(root)
  const transport = new OpenCodeSdkTransport({} as HarnessServices, { databasePath: path.join(root, "opencode.db") })
  transports.push(transport)
  const { host } = (transport as unknown as { runtime: OpenCodeRuntime }).runtime
  expect(host.status().lifecycle).toBe("cold")
  takeEventLoopActivity()

  await transport.prepare(root)

  expect(host.status().lifecycle).toBe("ready")
  expect(fs.existsSync(path.join(root, "opencode.db"))).toBe(true)
  expect(takeEventLoopActivity()).toEqual(["opencode engine boot", "opencode location activation"])
})
