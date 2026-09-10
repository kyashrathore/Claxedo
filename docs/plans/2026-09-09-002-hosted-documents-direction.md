# Hosted Documents: product and cleanup direction

Status: proposal grounded in the current checkout; runtime behavior has not been changed.

## Objective

Documents are signed-in, hosted content that people and agents can create, update,
and open in a workspace panel. R2 owns durable content. Documents have no repository
file identity and no unsigned or local storage mode.

Hosted describes document ownership and storage. An authorized agent may execute
locally or in a cloud workspace; it uses the same hosted document service. A local
agent does not gain document access merely because it runs on loopback.

## Current code and change points

- `packages/claxedo-app/src/features/documents/access.ts` currently admits a signed
  principal OR loopback transport. Replace this with signed identity AND an enabled,
  reachable hosted Documents capability. Server authorization remains authoritative.
- `packages/claxedo-app/src/features/documents/editor/document-index.tsx` owns
  listing and creation. Preserve the index UX, with kind filtering and no local
  directory inference for hosted project identity.
- `packages/claxedo-app/src/app/workbench/review/review-workspace.tsx` registers
  repository Markdown through `collaborateWithMarkdown()`. Remove this action.
  Normal repository file viewing and editing remain file features.
- `packages/claxedo-mcp/src/tools/documents.ts` currently lists metadata and turns
  a document into a session file path. Replace that contract with service-backed
  content operations and stable document references.
- `packages/claxedo-server/src/documents/backends/hosted/backend.ts` and
  `managed.ts` implement R2 content, conditional writes, and snapshots. Their
  production factory is not composed into the hosted app today.
- `packages/claxedo-documents-service/src/worker.cf.ts` composes lifecycle handling
  but no document runtime. `service.ts` explicitly rejects missing runtime support.
  Complete this service as the owner rather than introducing a second hosted owner.
- `packages/claxedo-app/src/features/documents/editor/document-editor.tsx` has
  serialized autosave and recovery, but no subscription to external document
  changes. Wire canonical content updates into the existing persistence controller.

## One identity, three content kinds

| Kind | Durable body | Panel experience |
| --- | --- | --- |
| `document` | Markdown | Existing rich/source editor and version history |
| `report` | Versioned, validated component document | Claxedo components, tables, metrics, charts, and prose |
| `html` | HTML text | Isolated HTML preview, with source available |

These are renderer-discriminating kinds, not independent storage products. Each
shares document identity, project ownership, revisions, archive, authorization,
and panel routing. Keep kind fixed after creation initially; conversion can be a
separate explicit operation if needed later.

Proposed common metadata: `id`, `projectId`, `kind`, `title`, `schemaVersion`,
`revision`, `createdBy`, optional `sourceSessionId`, timestamps, and archive state.
Organization and authorship come from verified credentials. Remove `origin_kind`,
`placement_kind`, installation identifiers, repository paths, branch, and local
directory fields from the new public document model. Workspace placement is panel
context, not storage identity.

The service owns one authoritative metadata index. Reuse and relocate the current
R2 index initially; do not create a second D1 document index as part of this cleanup.
D1 already used by the service for lifecycle management has a separate responsibility.
The existing job/grant contract must be completed or replaced coherently with typed
document operations; the lifecycle shell is not proof that writes are implemented.

## Agent creates a document

1. The agent calls proposed `documents_create({ kind, title, content })` through
   claxedo-mcp. Runtime credentials supply the session and authorized project;
   an account caller explicitly selects an authorized project.
2. The MCP adapter calls the signed hosted API. The API verifies the principal,
   project write access, and enabled service installation. The service verifies
   the scoped operation grant. Neither accepts organization or actor claims from
   model-generated content.
3. The service validates the body by kind, persists the R2 content and metadata,
   and only then returns `{ id, revision, uri, kind, title }`. Use a stable operation
   identity for retries so a timeout cannot create duplicate documents. Reconcile
   failures between content and index writes before reporting success.
4. The URI retains `claxedo://document/<id>`. The app renders a document result that
   opens the existing workbench surface by ID. This is a proposed typed tool-result
   integration; returning a URI string alone does not implement panel opening.
5. The panel reads authorized metadata and content and chooses its renderer by
   `kind`. Reopening after restart uses the ID and durable service state.

Keep creation and presentation distinct. A document remains successfully saved if
the originating UI is closed. The result is always openable. If automatic opening
is included, use an explicit presentation request addressed to the originating
workspace/UI connection; generic document-change events must not open panels on
every signed-in client. Repeated presentation reuses an existing tab.

The small proposed tool set is `documents_create`, `documents_get`,
`documents_update`, and `documents_list`, plus an explicit presentation operation
if agents need to open previously created documents. Updates require a revision
precondition. Do not silently change the existing path-returning `documents_open`
meaning: remove its consumers and update the CLI, bundled skill, and tests together.

No session working file is needed for these operations. The model reads and writes
through MCP. This removes document hydration, filesystem watchers, runtime writeback,
relay-to-local document access, and document-specific token renewal machinery.

## Human editing and live updates

Human Markdown edits continue through the persistence controller and hosted API.
Keep its recovery drafts, serialized saves, conditional writes, and explicit
conflict choices. Recovery storage is a cache, never a local document backend.

After a committed mutation, publish one authoritative document-change notification.
An open panel refetches canonical content. A clean editor adopts the new revision;
a dirty editor invokes the controller's conflict path and preserves its draft.
On reconnect, revalidate the current document rather than assuming every event was
delivered. Reports and HTML previews render only validated committed revisions.

## Reports and protocol choice

Proposed default, pending product feedback: reports use a small Claxedo-owned
component catalog. Map approved names and props onto internal UI components;
agents do not submit executable JSX or arbitrary imports. Add report-specific
compositions only where the internal library lacks a needed concept.

A2UI fits this catalog contract. Select and pin a protocol version after validating
a renderer against the app's Solid stack; there is no A2UI renderer wired in the
current checkout. Persist a versioned report snapshot sufficient to reconstruct
the surface, not an unreduced transient message stream. Validate schemas, component
references, bounded size/depth, and catalog compatibility before committing.

AG-UI handles agent/UI event exchange. It is not required merely to save and render
a report. Keep the current session and document event owners. Add an AG-UI adapter
only for a concrete interaction requirement; do not introduce another agent run
state owner. Report actions, if supported, go through typed authorized app commands.
Start with presentational reports rather than making every report an agent app.

HTML is a separate content kind. Render it in an isolated iframe with a restrictive
content policy and no access to Claxedo cookies, tokens, parent DOM, or app APIs.
Start with static HTML/CSS; script execution and external resources require a
separate explicit product decision. Never inject generated HTML into the app DOM.

References checked for this proposal:
- [A2UI custom catalogs and components](https://a2ui.org/guides/authoring-components/)
- [AG-UI event responsibilities](https://docs.ag-ui.com/concepts/events)

## Complete implementation slices

1. **Hosted Markdown through real entrypoints.** Finish the Documents service,
   signed hosted route contribution, scoped MCP authentication, create/get/update/list,
   typed document result, and panel loading. Preserve revision conflicts and snapshots.
2. **Cut over and remove old ownership.** Remove unsigned admission, local mounts,
   repository registration/move/relocate/Git operations, local document indexes and
   storage implementations, and document-only hydration/broker/writeback code once
   all consumers move. Remove related contracts, CLI commands, skills, and obsolete
   tests. Preserve shared workspace/session authentication and relay mechanisms.
3. **Add HTML.** Extend the body contract and renderer with iframe isolation and
   reopening/export verification.
4. **Add reports.** Establish the catalog and report schema, validate one complete
   report through MCP, R2, reload, and the native component renderer.

The final state has no local/repository fallback. Existing repository and managed
files must not be deleted as a side effect of removing support. Before a production
cutover, inventory existing documents and decide their export/migration treatment.
No automatic upload of local content is authorized by this proposal.

## Acceptance evidence required

- Signed-in authorized creation through the actual MCP endpoint persists R2 content,
  returns a stable reference, and opens in the intended workspace panel.
- Reload/restart retains the content and selects the correct renderer.
- Unsigned, expired/revoked, cross-project, and cross-organization access is denied;
  runtime credentials cannot choose another session's or project's scope.
- Retried creates do not duplicate content; failed persistence never reports saved.
- Human/agent concurrent updates conflict without losing either draft; reconnect
  reconciles an open panel and does not create duplicate tabs.
- Service disabled/unavailable state is visible and does not invoke a local path.
- HTML cannot access the application origin; invalid report catalogs are rejected.
- Repository file editing still works independently; document registration and old
  hydration entrypoints are absent.
- Run owning-package tests/typechecks, `bun run test:architecture-ratchets` for
  production import changes, affected closure verification when required, and a
  deployed hosted MCP-to-panel journey. Unit tests alone do not prove this cutover.
