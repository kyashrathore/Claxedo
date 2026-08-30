import { afterEach, describe, expect, test, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { OpenCodeRuntime } from "@claxedo/opencode-runtime"
import { disposeAgentConfig, saveUserConfig } from "@claxedo/server-core/agent-config/index"
import {
  configureOpencodeMcpSync,
  connectOpencodeMcp,
  disconnectOpencodeMcp,
  opencodeMcpStatus,
  syncOpencodeMcpConfig,
} from "./mcp-sync"

const roots: string[] = []
const previousDataDir = process.env.CLAXEDO_DATA_DIR

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-mcp-sdk-"))
  const directory = path.join(root, "workspace")
  await fs.mkdir(directory)
  roots.push(root)
  process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
  return directory
}

function fakeRuntime() {
  const configuration = {
    mcpStatus: vi.fn(async () => ({ existing: { status: "connected" } })),
    addMcp: vi.fn(async () => ({ docs: { status: "connected" } })),
    removeMcp: vi.fn(async () => {}),
    connectMcp: vi.fn(async () => true),
    disconnectMcp: vi.fn(async () => true),
  }
  return {
    runtime: { configuration } as unknown as OpenCodeRuntime,
    configuration,
  }
}

afterEach(async () => {
  disposeAgentConfig()
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("OpenCode SDK MCP sync", () => {
  test("routes status and connection operations through the typed configuration port", async () => {
    const directory = await workspace()
    const { runtime, configuration } = fakeRuntime()
    configureOpencodeMcpSync({ runtime })

    expect(await opencodeMcpStatus({ directory, workspaceID: "ws_mcp" })).toEqual({
      existing: { status: "connected" },
    })
    expect(await connectOpencodeMcp({ directory, workspaceID: "ws_mcp", name: "docs" })).toBe(true)
    expect(await disconnectOpencodeMcp({ directory, workspaceID: "ws_mcp", name: "docs" })).toBe(true)

    expect(configuration.connectMcp).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceID: "ws_mcp" }),
      "docs",
    )
    expect(configuration.disconnectMcp).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceID: "ws_mcp" }),
      "docs",
    )
  })

  test("pushes effective MCP configuration through typed SDK operations", async () => {
    const directory = await workspace()
    await saveUserConfig({
      mcp: {
        docs: {
          type: "stdio",
          command: "node",
          args: ["/tmp/docs-mcp.js"],
        },
      },
      auth: {},
    })
    const { runtime, configuration } = fakeRuntime()
    configureOpencodeMcpSync({ runtime })

    expect(await syncOpencodeMcpConfig({ directory, workspaceID: "ws_mcp_sync" })).toEqual([{
      name: "docs",
      ok: true,
      status: 200,
      body: { docs: { status: "connected" } },
    }])
    expect(configuration.addMcp).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceID: "ws_mcp_sync" }),
      "docs",
      {
        type: "local",
        command: ["node", "/tmp/docs-mcp.js"],
        environment: {},
      },
    )
  })
})
