import { afterEach, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { sessionEnvBashTool } from "../../../agent-sdk-runtime/src/harnesses/pi/model-backend"
import { releaseEmbeddedWorkspaceRuntime } from "../embedded-workspace-runtime"
import type { Workspace } from "../workspace-store"
import {
  disposeHydratedSessionDocuments,
  hydrateSessionDocument,
  hydratedSessionDocumentPaths,
} from "../documents/session-hydration"
import { createClaxedoSessionEnvFactory } from "./session-env"

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((run) => run()))
})

describe("real workspace-runtime document round-trip", () => {
  test("executes the submitted bash command, syncs exact bytes, and disposes the hydrated copy", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-session-real-runtime-"))
    const sessionId = `session-${randomUUID()}`
    const workspace = {
      id: `workspace-${randomUUID()}`,
      kind: "local",
      directory: path.join(root, "workspace"),
      created_at: Date.now(),
      updated_at: Date.now(),
    } satisfies Workspace
    await fs.mkdir(workspace.directory)
    const previousDataDir = process.env.CLAXEDO_DATA_DIR
    process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
    await fs.mkdir(process.env.CLAXEDO_DATA_DIR)
    cleanup.push(async () => {
      await disposeHydratedSessionDocuments(sessionId)
      releaseEmbeddedWorkspaceRuntime(workspace.id)
      if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
      if (previousDataDir !== undefined) process.env.CLAXEDO_DATA_DIR = previousDataDir
      await fs.rm(root, { recursive: true, force: true })
    })
    const canonical = path.join(root, "canonical.md")
    await fs.writeFile(canonical, "before")
    const hydrated = await hydrateSessionDocument({
      sessionId,
      workspaceRoot: workspace.directory,
      documentId: "document-a",
      displayName: "Plan",
      markdown: "before",
      baseVersion: "version-1",
      sync: async (markdown) => {
        await fs.writeFile(canonical, markdown)
        return "version-2"
      },
    })
    const env = await createClaxedoSessionEnvFactory({
      fetchOptions: {},
      resolveWorkspace: async () => workspace,
    })({
      sessionId,
      mode: "hybrid",
      host: "central",
      toolSandbox: { kind: "workspace-runtime", workspaceId: workspace.id },
    })

    const result = await sessionEnvBashTool(env).execute(
      "tool-call-document-edit",
      { command: `printf 'agent edit' > ${JSON.stringify(hydrated)}` },
      new AbortController().signal,
    )

    expect(result).toMatchObject({ details: { exitCode: 0 } })
    expect(await fs.readFile(canonical, "utf8")).toBe("agent edit")
    expect(hydratedSessionDocumentPaths(sessionId)).toEqual([hydrated])
    await env.dispose?.()
    expect(hydratedSessionDocumentPaths(sessionId)).toEqual([])
    await expect(fs.stat(hydrated)).rejects.toMatchObject({ code: "ENOENT" })
  })
})
