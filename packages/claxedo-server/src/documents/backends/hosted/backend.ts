import { createHostedDocumentIndex } from "./index"
import {
  createHostedManagedDocumentWorkspace,
  createR2ConditionalObjectStore,
  hostedManagedRelativePath,
  type R2BucketBinding,
} from "./managed"
import { mintDocumentSessionToken, verifyDocumentSessionToken } from "@claxedo/server-core/platform/auth/runtime-access-token"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { z } from "zod"
import { asRecord, isRecord, parseJson } from "@claxedo/server-core/platform/json/index"
import type { DocumentIndexEntry } from "@claxedo/server-core/documents/index-store"
import { toDocumentVersion } from "@claxedo/server-core/documents/port"
import {
  LocalDocumentIndexResponseSchema,
  LocalDocumentReadResponseSchema,
  LocalDocumentWriteResponseSchema,
  parseLocalDocumentResponse,
} from "./local-relay-contract"

export function createHostedDocumentsBackend(
  bucket: R2BucketBinding,
  options: Readonly<{
    runtime?: Readonly<{ open(input: {
      entry: DocumentIndexEntry
      sessionId: string
      auth: SignedControlPlaneAuth
      origin: string
      read: Readonly<{ markdown: string; version: string; modifiedAt: number }>
      jobExpiresAt?: number
      registerCapability?: (input: { jti: string; jobExpiresAt: number }) => Promise<void>
    }): Promise<Readonly<{ path: string }>>
    resolve?(input: {
      entry: DocumentIndexEntry
      sessionId: string
      auth: SignedControlPlaneAuth
      localWorkspaceId: string
      cloudWorkspaceId: string
      choice: "durable" | "draft"
      current: Readonly<{ markdown: string; version: string; modifiedAt: number }>
      jobExpiresAt: number
      writeback: { token: string; expiresAt: number }
    }): Promise<Readonly<{ path: string; preserved?: string; version: string }>> }>
    env?: NodeJS.ProcessEnv
    localRelay?: Readonly<{ request(input: {
      auth: SignedControlPlaneAuth
      orgId: string
      projectId: string
      localWorkspaceId: string
      cloudWorkspaceId: string
      sessionId: string
      documentId: string
      operation: "list" | "read" | "write" | "resolve"
      markdown?: string
      expectedVersion?: string
      jobExpiresAt: number
    }): Promise<unknown> }>
    resolveSessionWorkspace?: (auth: SignedControlPlaneAuth, sessionId: string) => Promise<string>
    resolveLocalWorkspace?: (auth: SignedControlPlaneAuth, projectId: string) => Promise<string>
    reauthorizeJob?: (input: {
      auth: SignedControlPlaneAuth
      entry: DocumentIndexEntry
      sessionId: string
      cloudWorkspaceId: string
      localWorkspaceId: string
    }) => Promise<void>
    listLocalWorkspaces?: (auth: SignedControlPlaneAuth) => Promise<readonly { workspaceId: string; projectId: string }[]>
  }> = {},
) {
  const store = createR2ConditionalObjectStore(bucket)
  const workspace = createHostedManagedDocumentWorkspace({ store })
  const index = createHostedDocumentIndex(store)
  const env = options.env ?? process.env

  async function putJob(sessionId: string, documentId: string, job: HostedDocumentJob) {
    const key = jobKey(sessionId, documentId)
    for (const _attempt of [0, 1, 2]) {
      const current = await store.get(key)
      if (await store.put(key, new TextEncoder().encode(JSON.stringify(job)), current ? { etag: current.etag } : { absent: true })) return
    }
    throw new Error("Document job authority update conflicted")
  }

  async function loadJob(sessionId: string, documentId: string) {
    const key = jobKey(sessionId, documentId)
    const object = await store.get(key)
    if (!object) throw new Error("Document job authority is unavailable")
    const value = parseJobRecord(object.body)
    if ("expired" in value) throw new Error("Document job authority expired")
    if (value.jobExpiresAt <= Math.floor(Date.now() / 1000)) {
      await store.put(key, new TextEncoder().encode(JSON.stringify({
        expired: true,
        jobExpiresAt: value.jobExpiresAt,
      } satisfies ExpiredDocumentJob)), { etag: object.etag })
      throw new Error("Document job authority expired")
    }
    return { object, value }
  }

  async function expireJob(sessionId: string, documentId: string, activeJti?: string) {
    const key = jobKey(sessionId, documentId)
    let targetJti = activeJti
    for (const _attempt of [0, 1, 2]) {
      const object = await store.get(key)
      if (!object) return
      const value = parseJobRecord(object.body)
      if ("expired" in value) return
      targetJti ??= value.activeJti
      if (value.activeJti !== targetJti) return
      if (await store.put(key, new TextEncoder().encode(JSON.stringify({
        expired: true,
        jobExpiresAt: value.jobExpiresAt,
      } satisfies ExpiredDocumentJob)), { etag: object.etag })) return
    }
    throw new Error("Document job capability expiration conflicted")
  }

  async function activeJob(documentId: string, input: {
    token: string; orgId: string; projectId: string; workspaceId: string; sessionId: string
  }) {
    const job = await loadJob(input.sessionId, documentId)
    const claims = await verifyDocumentSessionToken(input.token, { ...input, documentId }, env)
    if (job.value.activeJti !== claims.jti || job.value.jobExpiresAt !== claims.jobExpiresAt ||
      claims.jobExpiresAt <= Math.floor(Date.now() / 1000) || job.value.orgId !== input.orgId ||
      job.value.projectId !== input.projectId || job.value.cloudWorkspaceId !== input.workspaceId) {
      throw new Error("Document job capability is inactive")
    }
    return { ...job, claims, auth: await openJobAuth(job.value.sealedAuth, env) }
  }

  async function liveEntry(documentId: string, input: {
    token: string; orgId: string; projectId: string; workspaceId: string; sessionId: string
  }) {
    const job = await activeJob(documentId, input)
    if (job.value.placement === "hosted") {
      const entry = await index.find(input.orgId, documentId)
      if (!entry) throw new Error("Hosted document is unavailable")
      return { entry, job }
    }
    if (!options.localRelay) throw new Error("Local document relay is unavailable")
    const current = await options.localRelay.request({
      auth: job.auth,
      orgId: input.orgId,
      projectId: input.projectId,
      localWorkspaceId: job.value.localWorkspaceId,
      cloudWorkspaceId: job.value.cloudWorkspaceId,
      sessionId: input.sessionId,
      documentId,
      operation: "read",
      jobExpiresAt: job.value.jobExpiresAt,
    })
    const { entry } = parseLocalDocumentResponse(
      LocalDocumentReadResponseSchema,
      current,
      "Local document is unavailable",
    )
    return { entry, job }
  }
  return {
    index,
    workspace,
    managedRelativePath: (input: Readonly<{ documentId: string; slug: string }>) => hostedManagedRelativePath(input),
    placement: "hosted",
    placementId: "r2",
    ...(options.runtime ? {
      ...(options.localRelay ? { remoteList: async (input: {
        auth: SignedControlPlaneAuth
        orgId: string
        projectId: string
        localWorkspaceId: string
        cloudWorkspaceId: string
        sessionId: string
      }) => {
        const selected = await options.resolveLocalWorkspace?.(input.auth, input.projectId)
        if (!selected || selected !== input.localWorkspaceId) throw new Error("Local document installation is unavailable")
        const result = await options.localRelay!.request({
          ...input,
          documentId: "*",
          operation: "list",
          jobExpiresAt: Math.floor(Date.now() / 1000) + 15 * 60,
        })
        return parseLocalDocumentResponse(
          LocalDocumentIndexResponseSchema,
          result,
          "Local document index response is invalid",
        )
      }, remoteFind: async (input: { auth: SignedControlPlaneAuth; orgId: string; documentId: string }) => {
        if (!options.listLocalWorkspaces) return undefined
        const workspaces = await options.listLocalWorkspaces(input.auth)
        if (workspaces.length > 100) throw new Error("Remote document installation discovery exceeds its bound")
        const matches = (await Promise.all(workspaces.map(async (workspace) => {
          const result = await options.localRelay!.request({
            auth: input.auth,
            orgId: input.orgId,
            projectId: workspace.projectId,
            localWorkspaceId: workspace.workspaceId,
            cloudWorkspaceId: workspace.workspaceId,
            sessionId: `discovery_${input.documentId}`,
            documentId: "*",
            operation: "list",
            jobExpiresAt: Math.floor(Date.now() / 1000) + 5 * 60,
          }).catch(() => undefined)
          return LocalDocumentIndexResponseSchema.safeParse(result)
            .data?.find((entry) => entry.id === input.documentId)
        }))).filter((entry): entry is DocumentIndexEntry => Boolean(entry))
        if (matches.length > 1) throw new Error("Remote document identity is ambiguous")
        return matches[0]
      } } : {}),
      agentOpen: async (entry: DocumentIndexEntry, sessionId: string, context: { auth?: SignedControlPlaneAuth; origin: string }) => {
        if (!context.auth) throw new Error("Hosted document hydration requires signed authentication")
        const auth = context.auth
        const cloudWorkspaceId = options.resolveSessionWorkspace
          ? await options.resolveSessionWorkspace(auth, sessionId)
          : entry.workspace_id ?? ""
        const localWorkspaceId = entry.placement_kind === "local"
          ? entry.workspace_id ?? await options.resolveLocalWorkspace?.(auth, entry.project_id) ?? ""
          : cloudWorkspaceId
        const read = await (async () => {
          if (entry.placement_kind === "hosted") return await workspace.read(await workspace.resolve(portEntry(entry)))
          if (!options.localRelay || !options.resolveSessionWorkspace || !localWorkspaceId) {
            throw new Error("Local document relay is unavailable")
          }
          const value = await options.localRelay.request({
            auth,
            orgId: entry.org_id,
            projectId: entry.project_id,
            localWorkspaceId,
            cloudWorkspaceId,
            sessionId,
            documentId: entry.id,
            operation: "read",
            jobExpiresAt: Math.floor(Date.now() / 1000) + 60 * 60,
          })
          return parseLocalDocumentResponse(LocalDocumentReadResponseSchema, value, "Local document read is invalid").read
        })()
        const jobExpiresAt = Math.floor(Date.now() / 1000) + 60 * 60
        const sealedAuth = await sealJobAuth(auth, env)
        await expireJob(sessionId, entry.id)
        let registeredJti: string | undefined
        return await options.runtime!.open({
          entry, sessionId, auth, origin: context.origin, read, jobExpiresAt,
          registerCapability: async (capability) => {
            await putJob(sessionId, entry.id, {
              orgId: entry.org_id,
              projectId: entry.project_id,
              localWorkspaceId,
              cloudWorkspaceId,
              placement: entry.placement_kind,
              jobExpiresAt: capability.jobExpiresAt,
              activeJti: capability.jti,
              sealedAuth,
            })
            registeredJti = capability.jti
          },
        }).catch(async (error) => {
          if (registeredJti) await expireJob(sessionId, entry.id, registeredJti)
          throw error
        })
      },
      runtimeEntry: async (documentId: string, input: {
        token: string; orgId: string; projectId: string; workspaceId: string; sessionId: string
      }) => (await liveEntry(documentId, input)).entry,
      runtimeResolve: async (entry: DocumentIndexEntry, input: {
        auth: SignedControlPlaneAuth; sessionId: string; choice: "durable" | "draft"
      }) => {
        if (!options.runtime?.resolve || entry.archived_at) throw new Error("Document conflict resolution is unavailable")
        const job = await loadJob(input.sessionId, entry.id)
        const original = await openJobAuth(job.value.sealedAuth, env)
        if (!job.value.activeJti || job.value.jobExpiresAt <= Math.floor(Date.now() / 1000) ||
          original.user.subject !== input.auth.user.subject || job.value.orgId !== entry.org_id ||
          job.value.projectId !== entry.project_id) throw new Error("Document conflict job is inactive")
        if (options.resolveSessionWorkspace &&
          await options.resolveSessionWorkspace(input.auth, input.sessionId) !== job.value.cloudWorkspaceId) {
          throw new Error("Session placement changed")
        }
        await options.reauthorizeJob?.({
          auth: input.auth,
          entry,
          sessionId: input.sessionId,
          cloudWorkspaceId: job.value.cloudWorkspaceId,
          localWorkspaceId: job.value.localWorkspaceId,
        })
        const current = entry.placement_kind === "hosted"
          ? await workspace.read(await workspace.resolve(portEntry(entry)))
          : await (async () => {
              if (!options.localRelay) throw new Error("Local document relay is unavailable")
              const value = await options.localRelay.request({
                auth: input.auth,
                orgId: entry.org_id,
                projectId: entry.project_id,
                localWorkspaceId: job.value.localWorkspaceId,
                cloudWorkspaceId: job.value.cloudWorkspaceId,
                sessionId: input.sessionId,
                documentId: entry.id,
                operation: "read",
                jobExpiresAt: job.value.jobExpiresAt,
              })
              return parseLocalDocumentResponse(
                LocalDocumentReadResponseSchema,
                value,
                "Local document is unavailable",
              ).read
            })()
        const scope = {
          orgId: entry.org_id,
          projectId: entry.project_id,
          workspaceId: job.value.cloudWorkspaceId,
          sessionId: input.sessionId,
          documentId: entry.id,
        }
        const next = await mintDocumentSessionToken({ ...scope, jobExpiresAt: job.value.jobExpiresAt }, env)
        const rotated = await store.put(jobKey(input.sessionId, entry.id), new TextEncoder().encode(JSON.stringify({
          ...job.value, activeJti: next.jti,
        })), { etag: job.object.etag })
        if (!rotated) throw new Error("Document conflict capability rotation conflicted")
        return await options.runtime.resolve({
          entry,
          sessionId: input.sessionId,
          auth: input.auth,
          localWorkspaceId: job.value.localWorkspaceId,
          cloudWorkspaceId: job.value.cloudWorkspaceId,
          choice: input.choice,
          current,
          jobExpiresAt: job.value.jobExpiresAt,
          writeback: { token: next.token, expiresAt: next.expiresAt },
        })
      },
      runtimeDispose: async (entry: DocumentIndexEntry, input: {
        token: string; orgId: string; projectId: string; workspaceId: string; sessionId: string
      }) => {
        const job = await activeJob(entry.id, input)
        const tombstoned = await store.put(jobKey(input.sessionId, entry.id), new TextEncoder().encode(JSON.stringify({
          expired: true,
          jobExpiresAt: job.value.jobExpiresAt,
        } satisfies ExpiredDocumentJob)), { etag: job.object.etag })
        if (!tombstoned) throw new Error("Document job disposal conflicted")
      },
      runtimeWriteback: async (entry: DocumentIndexEntry, input: {
        token: string
        orgId: string
        projectId: string
        workspaceId: string
        sessionId: string
        markdown: string
        expectedVersion: string
      }) => {
        const job = await activeJob(entry.id, input)
        if (entry.org_id !== input.orgId || entry.project_id !== input.projectId) throw new Error("Document write-back scope is invalid")
        if (entry.archived_at) throw new Error("Archived documents cannot be written back")
        if (entry.placement_kind === "local") {
          if (!options.localRelay) throw new Error("Local document relay is unavailable")
          const result = await options.localRelay.request({
            auth: job.auth,
            orgId: input.orgId,
            projectId: input.projectId,
            localWorkspaceId: job.value.localWorkspaceId,
            cloudWorkspaceId: job.value.cloudWorkspaceId,
            sessionId: input.sessionId,
            documentId: entry.id,
            operation: "write",
            markdown: input.markdown,
            expectedVersion: input.expectedVersion,
            jobExpiresAt: job.value.jobExpiresAt,
          })
          return parseLocalDocumentResponse(
            LocalDocumentWriteResponseSchema,
            result,
            "Local document write-back response is invalid",
          )
        }
        const written = await workspace.write(await workspace.resolve(portEntry(entry)), {
          markdown: input.markdown,
          expectedVersion: toDocumentVersion(input.expectedVersion),
          actor: { type: "agent", id: input.sessionId },
          sessionId: input.sessionId,
        })
        await index.update({ orgId: input.orgId, projectId: input.projectId }, entry.id, { last_known_file_version: written.version })
        return written
      },
      runtimeRenew: async (entry: DocumentIndexEntry, input: {
        token: string
        orgId: string
        projectId: string
        workspaceId: string
        sessionId: string
      }) => {
        if (entry.archived_at) throw new Error("Document renewal job is inactive")
        const live = await liveEntry(entry.id, input)
        const job = live.job
        const currentEntry = live.entry
        if (currentEntry.archived_at || job.value.jobExpiresAt <= Math.floor(Date.now() / 1000)) throw new Error("Document renewal job is inactive")
        if (options.resolveSessionWorkspace &&
          await options.resolveSessionWorkspace(job.auth, input.sessionId) !== job.value.cloudWorkspaceId) throw new Error("Session placement changed")
        await options.reauthorizeJob?.({
          auth: job.auth, entry: currentEntry, sessionId: input.sessionId,
          cloudWorkspaceId: job.value.cloudWorkspaceId, localWorkspaceId: job.value.localWorkspaceId,
        })
        if (currentEntry.placement_kind === "local" && options.localRelay) {
          const current = await options.localRelay.request({
            auth: job.auth,
            orgId: input.orgId,
            projectId: input.projectId,
            localWorkspaceId: job.value.localWorkspaceId,
            cloudWorkspaceId: job.value.cloudWorkspaceId,
            sessionId: input.sessionId,
            documentId: currentEntry.id,
            operation: "read",
            jobExpiresAt: job.value.jobExpiresAt,
          })
          const remote = LocalDocumentReadResponseSchema.safeParse(current).data
          if (!remote || remote.entry.archived_at) {
            throw new Error("Local document is archived or unavailable")
          }
        }
        const scope = {
          orgId: input.orgId, projectId: input.projectId, workspaceId: input.workspaceId,
          sessionId: input.sessionId, documentId: entry.id,
        }
        if (currentEntry.org_id !== input.orgId || currentEntry.project_id !== input.projectId) throw new Error("Document renewal scope is invalid")
        const next = await mintDocumentSessionToken({ ...scope, jobExpiresAt: job.value.jobExpiresAt }, env)
        const rotated = await store.put(jobKey(input.sessionId, currentEntry.id), new TextEncoder().encode(JSON.stringify({
          ...job.value, activeJti: next.jti,
        })), { etag: job.object.etag })
        if (!rotated) throw new Error("Document capability rotation conflicted")
        return next
      },
    } : {}),
  }
}

/**
 * The job authority record, stored as one R2 object per session/document. It is
 * written and read only here, so the schema is both the write shape and the read
 * validation: a corrupt or drifted object is rejected as a job-authority error
 * instead of flowing on as a half-typed record.
 */
const HostedDocumentJobSchema = z.object({
  orgId: z.string().min(1),
  projectId: z.string().min(1),
  localWorkspaceId: z.string(),
  cloudWorkspaceId: z.string(),
  placement: z.enum(["local", "hosted"]),
  jobExpiresAt: z.number(),
  activeJti: z.string(),
  sealedAuth: z.string(),
})

const ExpiredDocumentJobSchema = z.object({ expired: z.literal(true), jobExpiresAt: z.number() })

const DocumentJobRecordSchema = z.union([ExpiredDocumentJobSchema, HostedDocumentJobSchema])

type HostedDocumentJob = Readonly<z.infer<typeof HostedDocumentJobSchema>>

type ExpiredDocumentJob = Readonly<z.infer<typeof ExpiredDocumentJobSchema>>

function parseJobRecord(body: Uint8Array) {
  let parsed: unknown
  try {
    parsed = parseJson(new TextDecoder().decode(body))
  } catch {
    throw new Error("Document job authority is corrupt")
  }
  const record = DocumentJobRecordSchema.safeParse(parsed)
  if (!record.success) throw new Error("Document job authority is corrupt")
  return record.data
}

function jobKey(sessionId: string, documentId: string) {
  return `document-jobs/${encodeURIComponent(sessionId)}/${encodeURIComponent(documentId)}.json`
}

async function sealJobAuth(auth: SignedControlPlaneAuth, env: NodeJS.ProcessEnv) {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    await jobAuthKey(env),
    new TextEncoder().encode(JSON.stringify(auth)),
  ))
  return `${base64(nonce)}.${base64(encrypted)}`
}

async function openJobAuth(value: string, env: NodeJS.ProcessEnv) {
  const [nonce, encrypted] = value.split(".")
  if (!nonce || !encrypted) throw new Error("Document job authority is corrupt")
  const opened: unknown = parseJson(new TextDecoder().decode(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unbase64(nonce) },
    await jobAuthKey(env),
    unbase64(encrypted),
  )))
  if (!isSealedControlPlaneAuth(opened)) throw new Error("Document job authority is corrupt")
  return opened
}

/**
 * `sealJobAuth` above is the only producer, and AES-GCM already proves the bytes
 * are ours and unmodified. What still has to be checked is that the sealed value
 * came from a *current* build: the identity fields every caller reads. Deeper
 * members (`principal`) are carried through untouched, so they are covered by the
 * seal rather than re-validated here.
 */
function isSealedControlPlaneAuth(value: unknown): value is SignedControlPlaneAuth {
  if (!isRecord(value) || value.mode !== "signed") return false
  const user = asRecord(value.user)
  return typeof user?.subject === "string" && typeof user.tokenIdentifier === "string" && typeof user.issuer === "string"
}

async function jobAuthKey(env: NodeJS.ProcessEnv) {
  const secret = env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM?.replaceAll("\\n", "\n").trim()
  if (!secret) throw new Error("Document job authority encryption is unavailable")
  return await crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`claxedo-document-job:${secret}`)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  )
}

function base64(value: Uint8Array) {
  return btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join(""))
}

function unbase64(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

function portEntry(entry: DocumentIndexEntry) {
  if (entry.origin_kind === "managed") return {
    origin: "managed" as const,
    placement: entry.placement_kind,
    orgId: entry.org_id,
    projectId: entry.project_id,
    documentId: entry.id,
    relativePath: entry.managed_relative_path,
  }
  return {
    origin: "repository" as const,
    placement: entry.placement_kind,
    orgId: entry.org_id,
    projectId: entry.project_id,
    documentId: entry.id,
    relativePath: entry.repository_relative_path,
    workspaceId: entry.workspace_id,
  }
}
