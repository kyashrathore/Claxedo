import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { exportPKCS8, exportSPKI, generateKeyPair, SignJWT } from "jose"
import { describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { mintRuntimeAccessToken, runtimeAccessTokenIssuer } from "@claxedo/workspace-relay"
import type { DocumentBrokerBackend } from "@claxedo/server-core/documents/backend"
import { createLocalManagedDocumentWorkspace, managedDocumentRelativePath } from "@claxedo/server-core/documents/backends/local/managed"
import { createLocalDocumentJobState, LocalInstallationDocumentBroker } from "./installation-broker"
import type { DocumentIndexEntry } from "@claxedo/server-core/documents/index-store"
import { documentRelayJobTokenAudience, mintDocumentRelayJobToken } from "@claxedo/server-core/platform/auth/runtime-access-token"
import { documentTestAccess } from "../../../test-support/document-access"

describe("local installation document broker", () => {
  test("bounds revoked JTIs and prunes active plus revoked state at expiry", () => {
    let now = 100
    const jobs = createLocalDocumentJobState({ now: () => now, maxRevoked: 2 })
    expect(jobs.activate("one", 110)).toBe(true)
    expect(jobs.revoke("one", 110)).toBe(true)
    expect(jobs.activate("two", 110)).toBe(true)
    expect(jobs.revoke("two", 110)).toBe(true)
    expect(jobs.activate("three", 110)).toBe(false)
    expect(jobs.active("one", 110)).toBe(false)
    expect(jobs.active("two", 110)).toBe(false)
    expect(jobs.size()).toEqual({ active: 0, revoked: 2 })
    now = 111
    expect(jobs.size()).toEqual({ active: 0, revoked: 0 })
    expect(jobs.activate("three", 120)).toBe(true)
  })

  test("enforces job scope, revocation, and conditional writes at the installation broker", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-document-relay-"))
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const privatePem = await exportPKCS8(key.privateKey)
    const publicPem = await exportSPKI(key.publicKey)
    const env = {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: privatePem,
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: publicPem,
      CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM: "EdDSA",
    }
    const managed = createLocalManagedDocumentWorkspace({ dataRoot: root })
    const entry = {
      id: "document_1",
      org_id: "org_1",
      creator_id: "user_1",
      project_id: "project_1",
      display_name: "Plan",
      origin_kind: "managed",
      placement_kind: "local",
      placement_id: "local",
      managed_relative_path: managedDocumentRelativePath({
        projectId: "project_1",
        documentId: "document_1",
        slug: "Plan",
      }),
      repository_id: null,
      workspace_id: null,
      repository_relative_path: null,
      branch: null,
      status: "draft",
      session_id: null,
      archived_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_opened_at: null,
      last_known_file_version: null,
    } satisfies DocumentIndexEntry
    const entries: DocumentIndexEntry[] = [entry]
    const index = {
      list: async () => entries,
      find: async (orgId: string, id: string) => entries.find((entry) => entry.org_id === orgId && entry.id === id),
      update: async () => entry,
    }
    const backend = {
      index,
      access: documentTestAccess(index, ["org_1"]),
      workspace: managed,
    } satisfies DocumentBrokerBackend<Awaited<ReturnType<typeof managed.resolve>>>
    const reads = vi.spyOn(managed, "read")
    const writes = vi.spyOn(managed, "write")
    const created = await managed.create(
      {
        origin: "managed",
        placement: "local",
        projectId: "project_1",
        documentId: entry.id,
        relativePath: entry.managed_relative_path,
      },
      { markdown: "before", actor: { type: "user", id: "user" } },
    )
    const local = new Hono().route(
      "/internal/documents",
      LocalInstallationDocumentBroker({
        backend,
        installationToken: "installation-secret",
        env,
      }),
    )
    try {
      const installationHeaders = {
        authorization: "Bearer installation-secret",
        "x-claxedo-document-broker": "1",
      }
      expect(
        (
          await local.request("http://local.test/internal/documents/document_1?org_id=org_1&project_id=project_1", {
            headers: installationHeaders,
          })
        ).status,
      ).toBe(403)
      const jobScope = {
        userId: "user_1",
        orgId: "org_1",
        projectId: "project_1",
        localWorkspaceId: "local_ws",
        cloudWorkspaceId: "cloud_ws",
        sessionId: "session_1",
        documentId: "document_1",
        operations: ["read"] as const,
        jobExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      }
      const job = await mintDocumentRelayJobToken(jobScope, {
        CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: privatePem,
        CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: publicPem,
        CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM: "EdDSA",
      })
      const jobHeaders = {
        ...installationHeaders,
        "x-claxedo-document-capability": job.token,
        "x-claxedo-document-user": "user_1",
        "x-claxedo-local-workspace": "local_ws",
        "x-claxedo-cloud-workspace": "cloud_ws",
        "x-claxedo-document-session": "session_1",
        "x-claxedo-document-id": "document_1",
        "x-claxedo-document-operation": "read",
      }
      expect(
        (
          await local.request("http://local.test/internal/documents/jobs/activate?org_id=org_1&project_id=project_1", {
            method: "POST",
            headers: jobHeaders,
          })
        ).status,
      ).toBe(200)
      expect(
        (
          await local.request("http://local.test/internal/documents/jobs/activate?org_id=org_1&project_id=project_1", {
            method: "POST",
            headers: { ...jobHeaders, "x-claxedo-document-operation": "write" },
          })
        ).status,
      ).toBe(403)
      expect(
        (
          await local.request("http://local.test/internal/documents/document_2?org_id=org_1&project_id=project_1", {
            headers: jobHeaders,
          })
        ).status,
      ).toBe(403)
      expect(
        (
          await local.request("http://local.test/internal/documents/document_1?org_id=org_1&project_id=project_2", {
            headers: jobHeaders,
          })
        ).status,
      ).toBe(403)
      const readOnlyWrite = await local.request("http://local.test/internal/documents/document_1?org_id=org_1&project_id=project_1", {
        method: "PUT", headers: { ...jobHeaders, "if-match": created.version, "content-type": "application/json" },
        body: JSON.stringify({ markdown: "unauthorized change", sessionId: "session_1" }),
      })
      expect(readOnlyWrite.status).toBe(403)
      expect(writes).not.toHaveBeenCalled()

      const scopedRequest = async (operation: "resolve" | "write" | "read", documentId = "document_1") => {
        const job = await mintDocumentRelayJobToken({ ...jobScope, documentId, operations: [operation] }, {
          CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: privatePem,
          CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: publicPem,
        })
        const headers = { ...jobHeaders, "x-claxedo-document-capability": job.token,
          "x-claxedo-document-operation": operation, "x-claxedo-document-id": documentId }
        const activated = await local.request("http://local.test/internal/documents/jobs/activate?org_id=org_1&project_id=project_1", { method: "POST", headers })
        expect(activated.status).toBe(200)
        return headers
      }
      const writer = await scopedRequest("write")
      const forgedSession = await local.request("http://local.test/internal/documents/document_1?org_id=org_1&project_id=project_1", {
        method: "PUT", headers: { ...writer, "if-match": created.version, "content-type": "application/json" },
        body: JSON.stringify({ markdown: "forged attribution", sessionId: "another_session" }),
      })
      expect(forgedSession.status).toBe(403)
      expect(writes).not.toHaveBeenCalled()
      expect((await local.request("http://local.test/internal/documents/document_1?org_id=org_1&project_id=project_1", { headers: writer })).status).toBe(403)

      const resolver = await scopedRequest("resolve")
      entries.push({ ...entry, id: "document_2" }, { ...entry, id: "other_workspace", origin_kind: "repository", managed_relative_path: null, repository_id: "repo_other", workspace_id: "another_workspace", repository_relative_path: "plan.md", branch: "main" })
      const indexUrl = "http://local.test/internal/documents/index?org_id=org_1&project_id=project_1"
      const scopedIndex = await local.request(indexUrl, { headers: resolver })
      expect(scopedIndex.status).toBe(200)
      expect(await scopedIndex.json()).toMatchObject([{ id: "document_1", org_id: "org_1" }])
      const otherWorkspace = await scopedRequest("read", "other_workspace")
      expect((await local.request("http://local.test/internal/documents/other_workspace?org_id=org_1&project_id=project_1", { headers: otherWorkspace })).status).toBe(404)
      expect(reads).not.toHaveBeenCalled()
      const projectResolver = await scopedRequest("resolve", "*")
      const projectIndex = await local.request(indexUrl, { headers: projectResolver })
      expect((await projectIndex.json() as DocumentIndexEntry[]).map((entry) => entry.id)).toEqual(["document_1", "document_2"])
      for (const url of [indexUrl.replace("org_1", "other_org"), indexUrl.replace("project_1", "other_project")]) {
        expect((await local.request(url, { headers: resolver })).status).toBe(403)
      }
      expect((await local.request(indexUrl, { headers: { ...resolver, "x-claxedo-document-session": "another_session" } })).status).toBe(403)
      entries.splice(1)

      const expired = await new SignJWT({
        user_id: "user_1",
        org_id: "org_1",
        project_id: "project_1",
        local_workspace_id: "local_ws",
        cloud_workspace_id: "cloud_ws",
        session_id: "session_1",
        document_id: "document_1",
        operations: ["read"],
        job_exp: Math.floor(Date.now() / 1000) - 1,
      })
        .setProtectedHeader({ alg: "EdDSA" })
        .setIssuer(runtimeAccessTokenIssuer)
        .setAudience(documentRelayJobTokenAudience)
        .setSubject("user_1")
        .setIssuedAt(Math.floor(Date.now() / 1000) - 10)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 1)
        .setJti("expired-job")
        .sign(key.privateKey)
      expect(
        (
          await local.request("http://local.test/internal/documents/jobs/activate?org_id=org_1&project_id=project_1", {
            method: "POST",
            headers: { ...jobHeaders, "x-claxedo-document-capability": expired },
          })
        ).status,
      ).toBe(403)
      const wrongAudience = await mintRuntimeAccessToken(
        {
          principalKind: "user",
          actorId: "user_1",
          actorKind: "human",
          orgId: "org_1",
          workspaceId: "local_ws",
          hostId: "host_1",
          role: "owner",
        },
        key.privateKey,
        "EdDSA",
      )
      expect(
        (
          await local.request("http://local.test/internal/documents/jobs/activate?org_id=org_1&project_id=project_1", {
            method: "POST",
            headers: { ...jobHeaders, "x-claxedo-document-capability": wrongAudience },
          })
        ).status,
      ).toBe(403)
      expect(
        (
          await local.request("http://local.test/internal/documents/jobs/revoke?org_id=org_1&project_id=project_1", {
            method: "POST",
            headers: jobHeaders,
          })
        ).status,
      ).toBe(200)
      expect(
        (
          await local.request("http://local.test/internal/documents/document_1?org_id=org_1&project_id=project_1", {
            headers: jobHeaders,
          })
        ).status,
      ).toBe(403)
      const writeUrl = "http://local.test/internal/documents/document_1?org_id=org_1&project_id=project_1"
      const write = (markdown: string, expectedVersion: string) => local.request(writeUrl, {
        method: "PUT",
        headers: { ...writer, "if-match": expectedVersion, "content-type": "application/json" },
        body: JSON.stringify({ markdown, sessionId: "session_1" }),
      })
      expect((await write("x".repeat(2 * 1024 * 1024 + 64 * 1024), created.version)).status).toBe(413)
      const written = await write("agent edit", created.version)
      expect(written.status).toBe(200)
      expect((await written.json() as { version: string }).version).not.toBe(created.version)
      expect(writes).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
        sessionId: "session_1", actor: { type: "agent", id: "session_1" },
      }))
      expect((await write("stale", created.version)).status).toBe(409)
      expect((await managed.read(await managed.resolve({
        origin: "managed", placement: "local", projectId: "project_1",
        documentId: entry.id, relativePath: entry.managed_relative_path,
      }))).markdown).toBe("agent edit")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
