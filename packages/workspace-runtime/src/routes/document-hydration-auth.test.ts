import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { exportSPKI, generateKeyPair, SignJWT } from "jose"
import { createWorkspaceRuntimeApp } from "../server"
import { relayWorkspaceRuntimeExposure } from "../exposure"
import { managedWorkspaceSessionAccessPolicy } from "../session-access-policy"
import { fetchDouble } from "../test-support/fetch-double"
import { flushRuntimeDocument, forgetRuntimeDocuments } from "./document-hydration"

const target = { workspaceId: "ws_documents", hostId: "host_documents" }
const sessionId = "session_docs"
const documentId = "document_docs"
const owner = "actor_doc_owner"
const viewer = "actor_doc_viewer"

async function fixture() {
  const relayKeys = await generateKeyPair("EdDSA")
  const documentKeys = await generateKeyPair("EdDSA", { extractable: true })
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-document-auth-"))
  const previous = {
    directory: process.env.WORKSPACE_RUNTIME_DIRECTORY,
    controlPlane: process.env.CLAXEDO_CONTROL_PLANE_URL,
    jobKey: process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM,
  }
  process.env.WORKSPACE_RUNTIME_DIRECTORY = workspaceDir
  process.env.CLAXEDO_CONTROL_PLANE_URL = "https://control.test"
  process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = await exportSPKI(documentKeys.publicKey)
  const asked: Array<{ operation: string | undefined; sessionId: string | undefined; actorId: string | undefined }> = []
  const runtime = createWorkspaceRuntimeApp({
    exposure: relayWorkspaceRuntimeExposure({ key: relayKeys.publicKey, ...target }),
    sessionAccessPolicy: {
      ...managedWorkspaceSessionAccessPolicy({ requireActor: true }),
      sessionAuthority: "managed-private",
      authorize(input) {
        asked.push({ operation: input.operation, sessionId: input.sessionId, actorId: input.actor?.actorId })
        return input.actor?.actorId === owner
          ? { allowed: true }
          : {
              allowed: false,
              status: 403 as const,
              code: "session_private",
              message: "Session access requires creator, participant, or session share authority",
            }
      },
    },
  })
  async function relay(actorId: string, role = "editor") {
    return await new SignJWT({
      principal_kind: "user", actor_id: actorId, actor_kind: "human",
      org_id: "org_documents", workspace_id: target.workspaceId, host_id: target.hostId,
      role, backing: "cloud-vm", parent_jti: "parent_doc",
    }).setProtectedHeader({ alg: "EdDSA" }).setIssuer("workspace-relay").setAudience("workspace-host-service")
      .setIssuedAt().setExpirationTime("1m").setJti(`relay_${actorId}`).sign(relayKeys.privateKey)
  }
  async function documentJob(userId: string, operations: string[]) {
    return await new SignJWT({
      user_id: userId, org_id: "org_documents", project_id: "project_docs",
      local_workspace_id: target.workspaceId, cloud_workspace_id: target.workspaceId,
      session_id: sessionId, document_id: documentId,
      operations, job_exp: Math.floor(Date.now() / 1000) + 3600, jti: `job_${userId}`,
    }).setProtectedHeader({ alg: "EdDSA" }).setIssuer("claxedo-control-plane").setAudience("document-relay-job")
      .setIssuedAt().setExpirationTime("1h").sign(documentKeys.privateKey)
  }
  const job = (token: string, userId: string) => ({
    token,
    userId,
    orgId: "org_documents",
    projectId: "project_docs",
    localWorkspaceId: target.workspaceId,
    cloudWorkspaceId: target.workspaceId,
  })
  const writeback = {
    url: "https://control.test/write",
    renewUrl: "https://control.test/renew",
    token: "writeback-token",
    expiresAt: Date.now() + 300_000,
  }
  async function hydrate(token: string, jobToken: string) {
    return await runtime.app.request("/api/wr/documents/hydrate", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-workspace-id": target.workspaceId,
        "x-forwarded-by": "workspace-relay",
      },
      body: JSON.stringify({
        sessionId,
        documentId,
        displayName: "Plan",
        markdown: "durable",
        baseVersion: "v1",
        job: job(jobToken, "user_doc_owner"),
        writeback,
      }),
    })
  }
  async function activate(token: string) {
    return await runtime.app.request(`/api/wr/documents/${sessionId}/${documentId}/activate`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-workspace-id": target.workspaceId,
        "x-forwarded-by": "workspace-relay",
      },
      body: "{}",
    })
  }
  async function resolve(token: string, jobToken: string, userId: string) {
    return await runtime.app.request(`/api/wr/documents/${sessionId}/${documentId}/resolve`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-workspace-id": target.workspaceId,
        "x-forwarded-by": "workspace-relay",
      },
      body: JSON.stringify({
        strategy: "use-remote",
        remoteVersion: "v2",
        remoteMarkdown: "durable current",
        job: job(jobToken, userId),
        writeback: { ...writeback, token: "fresh-writeback-token" },
      }),
    })
  }
  async function close() {
    forgetRuntimeDocuments()
    restoreEnv("WORKSPACE_RUNTIME_DIRECTORY", previous.directory)
    restoreEnv("CLAXEDO_CONTROL_PLANE_URL", previous.controlPlane)
    restoreEnv("CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM", previous.jobKey)
    await runtime.dispose()
    await fs.rm(workspaceDir, { recursive: true, force: true })
  }
  return { runtime, workspaceDir, relay, documentJob, hydrate, activate, resolve, asked, close }
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

describe("runtime document session authorization", () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("a caller the session authority refuses cannot activate or observe the hydrated path", async () => {
    const f = await fixture()
    try {
      const hydrated = await f.hydrate(await f.relay(owner), await f.documentJob("user_doc_owner", ["hydrate", "write"]))
      expect(hydrated.status).toBe(200)

      const denied = await f.activate(await f.relay(viewer))
      expect(denied.status).toBe(403)
      await expect(denied.json()).resolves.toEqual({
        error: {
          code: "session_private",
          message: "Session access requires creator, participant, or session share authority",
        },
      })
      expect(f.asked).toEqual([{ operation: "document_write", sessionId, actorId: viewer }])

      // A refused caller leaves the stored document pending: no watcher, no
      // write-back, and the hydration path is not observed.
      await expect(flushRuntimeDocument(sessionId, documentId)).rejects.toThrow("not activated")

      expect((await f.activate(await f.relay(owner))).status).toBe(200)
      expect(f.asked.at(-1)).toEqual({ operation: "document_write", sessionId, actorId: owner })
    } finally {
      await f.close()
    }
  })

  test("a refused caller cannot reach the resolution path even with a fresh capability", async () => {
    const f = await fixture()
    try {
      const hydrated = await f.hydrate(await f.relay(owner), await f.documentJob("user_doc_owner", ["hydrate", "write"]))
      expect(hydrated.status).toBe(200)

      const denied = await f.resolve(
        await f.relay(viewer),
        await f.documentJob("user_doc_viewer", ["resolve"]),
        "user_doc_viewer",
      )
      expect(denied.status).toBe(403)
      await expect(denied.json()).resolves.toEqual({
        error: {
          code: "session_private",
          message: "Session access requires creator, participant, or session share authority",
        },
      })

      // The authorized caller passes the session check and reaches the stored
      // document lookup, which has no conflict to resolve.
      const allowed = await f.resolve(
        await f.relay(owner),
        await f.documentJob("user_doc_owner", ["resolve"]),
        "user_doc_owner",
      )
      expect(allowed.status).toBe(404)
      await expect(allowed.json()).resolves.toEqual({ error: "document_conflict_not_found" })
      expect(f.asked).toEqual([
        { operation: "document_write", sessionId, actorId: viewer },
        { operation: "document_write", sessionId, actorId: owner },
      ])
    } finally {
      await f.close()
    }
  })

  test("the authorized caller still activates and resolves a conflicted document", async () => {
    const f = await fixture()
    globalThis.fetch = fetchDouble(async () => new Response("conflict", { status: 409 }))
    try {
      const hydrated = await f.hydrate(await f.relay(owner), await f.documentJob("user_doc_owner", ["hydrate", "write"]))
      expect(hydrated.status).toBe(200)
      const opened = (await hydrated.json()) as { path: string }
      expect((await f.activate(await f.relay(owner))).status).toBe(200)
      await fs.writeFile(opened.path, "session draft")
      await expect(flushRuntimeDocument(sessionId, documentId)).rejects.toThrow("conflicted")

      const resolved = await f.resolve(
        await f.relay(owner),
        await f.documentJob("user_doc_owner", ["resolve"]),
        "user_doc_owner",
      )
      expect(resolved.status).toBe(200)
      await expect(resolved.json()).resolves.toMatchObject({ path: opened.path })
    } finally {
      await f.close()
    }
  })
})
