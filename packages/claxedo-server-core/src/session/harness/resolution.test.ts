import { afterAll, beforeEach, describe, expect, test } from "vitest"
import { randomUUID } from "crypto"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"

const root = path.join(realpathSync(os.tmpdir()), `harness-resolution-test-${randomUUID().slice(0, 8)}`)
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const workspace = await import("@claxedo/server-core/workspace/store/index")
const sessionHarness = await import("./index")
const resolution = await import("./resolution")

describe("runner resolution", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
    if (prev === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = prev
  })

  test("resolves ACP session harness from saved session config", async () => {
    const directory = "/workspace"
    const ws = await workspace.ensureWorkspace({
      workspaceId: "ws_1",
      directory,
      kind: "cloud",
      status: "ready",
    })
    expect(ws?.id).toBe("ws_1")

    sessionHarness.setSessionConfig("ws_1", "ses_1", {
      harness: { id: "claude", access: "acp" },
      agent: "build",
      model: { providerID: "claude", modelID: "claude-opus-4-6" },
      variant: null,
    })

    const runner = await resolution.resolveHarnessForRequest({
      workspaceId: "ws_1",
      directory,
      sessionId: "ses_1",
    })

    expect(runner).toMatchObject({ id: "claude", access: "acp" })
  })

  test("accepts native harnesses from request inputs", () => {
    expect(resolution.parseHarness({ type: "claude" })).toEqual({ id: "claude", access: "native" })
    expect(resolution.parseHarness({ type: "codex" })).toEqual({ id: "codex", access: "native" })
  })

  test("resolves the workspace host when harness state cannot be resolved", async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, "user-agent-config.json"), "{")

    await expect(resolution.resolveHarnessForRequest()).rejects.toMatchObject({
      code: "user_agent_config_invalid_json",
    })
    await expect(resolution.resolveHarnessHostForRequest()).resolves.toBe("workspace")
  })
})
