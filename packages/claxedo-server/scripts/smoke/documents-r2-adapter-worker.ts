import {
  createHostedManagedDocumentWorkspace,
  createR2ConditionalObjectStore,
  hostedManagedRelativePath,
  type R2BucketBinding,
} from "../../src/documents/backends/hosted/managed"
import { DocumentVersionConflictError } from "../../src/documents/errors"

type Env = Readonly<{
  CLAXEDO_DOCUMENTS: R2BucketBinding
}>

export default {
  async fetch(request: Request, env: Env) {
    if (request.method !== "POST") return new Response("not found", { status: 404 })
    const nonce = new URL(request.url).searchParams.get("nonce")
    if (!nonce || !/^[a-z0-9_]+$/.test(nonce)) return Response.json({ error: "invalid nonce" }, { status: 400 })

    const store = createR2ConditionalObjectStore(env.CLAXEDO_DOCUMENTS)
    const workspace = createHostedManagedDocumentWorkspace({ store })
    const entry = {
      origin: "managed" as const,
      placement: "hosted" as const,
      orgId: `smoke_org_${nonce}`,
      projectId: `smoke_project_${nonce}`,
      documentId: `smoke_document_${nonce}`,
      relativePath: hostedManagedRelativePath({
        documentId: `smoke_document_${nonce}`,
        slug: "Adapter Smoke",
      }),
    }
    const handle = await workspace.resolve(entry)
    const prefixes = [
      `documents/${entry.orgId}/`,
      `document-history/${entry.orgId}/`,
      `document-publish/${entry.orgId}/`,
    ]

    try {
      const created = await workspace.create(entry, {
        markdown: "# Adapter smoke\n\ncreated through the production R2 adapter\n",
        actor: { type: "system", id: "r2-smoke" },
      })
      const first = await workspace.read(handle)
      const written = await workspace.write(handle, {
        markdown: "# Adapter smoke\n\nconditionally updated through the production R2 adapter\n",
        expectedVersion: created.version,
        actor: { type: "system", id: "r2-smoke" },
      })
      let staleCasRejected = false
      try {
        await workspace.write(handle, {
          markdown: "stale writer must not win\n",
          expectedVersion: created.version,
          actor: { type: "system", id: "r2-smoke" },
        })
      } catch (error) {
        if (!(error instanceof DocumentVersionConflictError)) throw error
        staleCasRejected = true
      }
      const final = await workspace.read(handle)
      const snapshots = await workspace.listSnapshots(handle)
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(final.markdown))

      return Response.json({
        adapter: "createR2ConditionalObjectStore",
        createdVersion: created.version,
        updatedVersion: written.version,
        versionAdvanced: created.version !== written.version,
        firstReadExact: first.markdown === "# Adapter smoke\n\ncreated through the production R2 adapter\n",
        finalReadExact:
          final.markdown === "# Adapter smoke\n\nconditionally updated through the production R2 adapter\n",
        staleCasRejected,
        snapshotCount: snapshots.length,
        finalSha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
      })
    } finally {
      await Promise.all(
        prefixes.map(async (prefix) => {
          const objects = await store.list(prefix)
          await Promise.all(objects.map((object) => store.delete(object.key)))
        }),
      )
    }
  },
}
