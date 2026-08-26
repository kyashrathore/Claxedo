import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { sessionEnvBashTool } from "../../../agent-sdk-runtime/src/harnesses/pi/model-backend"
import {
  disposeHydratedSessionDocuments,
  hydrateSessionDocument,
  hydratedSessionDocumentPaths,
} from "../../src/documents/session-hydration"
import { releaseEmbeddedWorkspaceRuntime } from "@claxedo/local-server/deployments/local/embedded-workspace-runtime"
import { createClaxedoSessionEnvFactory } from "../../src/hosts/workspace-runtime/session-env"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { configureAgentConfig } from "@claxedo/server-core/agent-config/index"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/db"

export async function runDocumentsSessionRoundtripSmoke() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-session-real-runtime-"))
  const sessionId = `session-${randomUUID()}`
  const workspace = {
    id: `workspace-${randomUUID()}`,
    kind: "local",
    directory: path.join(root, "workspace"),
    created_at: Date.now(),
    updated_at: Date.now(),
  } satisfies Workspace
  const canonicalPath = path.join(root, "canonical.md")
  const before = "before local session file-tool edit\n"
  const after = "after local session file-tool edit\n"
  const previousDataDir = process.env.CLAXEDO_DATA_DIR

  await fs.mkdir(workspace.directory)
  process.env.CLAXEDO_DATA_DIR = path.join(root, "data")
  await fs.mkdir(process.env.CLAXEDO_DATA_DIR)
  await fs.writeFile(canonicalPath, before)
  const hydratedPath = await hydrateSessionDocument({
    sessionId,
    workspaceRoot: workspace.directory,
    documentId: "document-session-smoke",
    displayName: "Session Smoke",
    markdown: before,
    baseVersion: "version-1",
    sync: async (markdown) => {
      await fs.writeFile(canonicalPath, markdown)
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

  try {
    const result = await sessionEnvBashTool(env).execute(
      "tool-call-document-edit",
      { command: `printf %b ${JSON.stringify(after)} > ${JSON.stringify(hydratedPath)}` },
      new AbortController().signal,
    )
    const canonical = await fs.readFile(canonicalPath, "utf8")
    const beforeSha256 = sha256(before)
    const afterSha256 = sha256(canonical)
    const hydratedBeforeDispose = hydratedSessionDocumentPaths(sessionId)
    await env.dispose?.()
    const disposed = hydratedSessionDocumentPaths(sessionId).length === 0 && !(await exists(hydratedPath))
    if (result.details.exitCode !== 0) throw new Error(`Session file tool exited ${result.details.exitCode}`)
    if (canonical !== after) throw new Error("Session file tool did not sync exact canonical bytes")
    if (beforeSha256 === afterSha256) throw new Error("Session file tool did not change the canonical hash")
    if (hydratedBeforeDispose.length !== 1 || !disposed)
      throw new Error("Session hydration lifecycle was not contained")

    return {
      sessionId,
      toolCallId: "tool-call-document-edit",
      exitCode: result.details.exitCode,
      beforeSha256,
      afterSha256,
      exactBytes: canonical === after,
      hydratedDocuments: hydratedBeforeDispose.length,
      disposed,
    }
  } finally {
    await disposeHydratedSessionDocuments(sessionId)
    releaseEmbeddedWorkspaceRuntime(workspace.id)
    configureAgentConfig()
    ClaxedoDB.close()
    if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
    if (previousDataDir !== undefined) process.env.CLAXEDO_DATA_DIR = previousDataDir
    // Close every sqlite handle opened under root before deleting it: Windows
    // answers an unlink of an open authority.db/claxedo.db with EBUSY, and
    // keeps a brief lock even after close (the retries absorb it).
    const { closeAuthorityDatabases } = await import("@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store")
    closeAuthorityDatabases()
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function exists(target: string) {
  return fs.stat(target).then(
    () => true,
    () => false,
  )
}

if (import.meta.main)
  console.log(`DOCUMENTS_SESSION_ROUNDTRIP ${JSON.stringify(await runDocumentsSessionRoundtripSmoke())}`)
