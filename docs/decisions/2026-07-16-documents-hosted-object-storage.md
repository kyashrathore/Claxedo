# Hosted Documents Object Storage

## Status

Accepted for the Documents hosted-managed backend.

## Context

Hosted managed documents require durable authority independent of Worker and
session compute. The Documents port needs opaque conditional versions,
immutable recovery snapshots, and tenant-scoped object keys.

## Decision

Cloudflare R2 is the first hosted object-store adapter behind a generic
conditional object-store interface. Canonical document objects use
`documents/<org-id>/<project-id>/<document-id>/<slug>.md`. The authenticated
organization identifier enters the backend as explicit `DocumentEntry.orgId`
tenant context; storage adapters never derive tenant identity from user input,
process globals, or the object key itself.

R2 ETags are opaque `DocumentVersion` values. Writes use `onlyIf.etagMatches`
and creates use `onlyIf.uploadedBefore` with the Unix epoch, so compare-and-swap
is enforced by durable storage rather than Worker memory. Snapshots are
immutable content objects with metadata sidecars and bounded pin-aware
retention under `document-history/<org-id>/<project-id>/<document-id>/`.

The generic emulator is the port-conformance acceptance surface. The R2
adapter is a thin mapping from R2 `get`/`put`/`delete`/`list` and conditional
options into that interface.

## Operational topology

Document SSE fan-out remains process-local for the first hosted deployment,
which therefore runs as a single active application instance for invalidation
liveness. CAS remains the correctness boundary. Clients refetch on focus and
once after SSE reconnect, so missed invalidations do not permit lost updates.

## Staging release evidence

At `2026-07-16T18:27:06Z`, commit
`d4566543b3f4797313676223c1e705a72f11fc76` was checked against the remote
`claxedo-documents-staging` R2 bucket with Wrangler `4.81.1`. The smoke uploaded
`smoke/documents-core-1784225970.md`, downloaded it through R2, and compared the
source and downloaded SHA-256 values. Both were
`08668efcb6749852646ca45dfc9ac8d446bd23d55ee10ae02fc105e34123c70e`.
The smoke object was deleted and the bucket subsequently reported zero objects
and zero bytes.

At `2026-07-16T19:28:06Z`, the worktree based on the same commit ran
`bun run smoke:documents-r2`. This launches
`scripts/smoke/documents-r2-adapter-worker.ts` through a Wrangler remote
preview with the `CLAXEDO_DOCUMENTS` binding connected to
`claxedo-documents-staging`. The smoke exercised the production
`createR2ConditionalObjectStore` and `createHostedManagedDocumentWorkspace`
code paths, rather than direct bucket commands. It created and read exact
Markdown, conditionally updated it, rejected a stale ETag writer, listed two
immutable snapshots, and deleted every object under its unique canonical,
history, and publish-claim prefixes in a `finally` cleanup. The canonical ETag
advanced from `38abe9042330c08d88432dfbf7a97e74` to
`5084de0f307c98b72fd25869258181c5`; the final exact bytes had SHA-256
`24ade5113d40b3f14cd3685307cd50b098af6780947acfa8e1cc863444030cd8`.
The response reported `firstReadExact: true`, `finalReadExact: true`,
`staleCasRejected: true`, and `snapshotCount: 2`.

The same production-adapter smoke was rerun at `2026-07-16T19:58:40Z`
after the final bounded snapshot-metadata validation and review fixes landed in
the worktree. It reproduced the same exact-read, version-advance, stale-CAS,
two-snapshot, cleanup, and final SHA-256 result.

Hydration and write-back behavior are covered separately by the hosted
integration suites. Together, the two staging checks record both the raw
real-bucket byte path and the final adapter's conditional object semantics.
