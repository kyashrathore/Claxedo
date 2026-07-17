# Hosted Document Session Write-Back

## Status

Accepted for hosted and remote document materialization.

## Context

Agent tools operate on ordinary files inside session compute. Hosted document
authority lives in object storage, while session files are disposable caches.
The synchronization owner must see the session filesystem and must preserve a
recoverable conditional base across runtime restarts.

## Decision

The workspace session runtime owns document hydration and write-back. It
persists one manifest inside the session namespace under
`.claxedo/sessions/<session-id>/docs/manifest.json`.
Each entry records `documentId`, materialized path, base version, last synced
content hash, and `active|conflicted` state.

Hydration downloads exactly the selected document to
`.claxedo/sessions/<session-id>/docs/<document-id>/<slug>.md`; discovery never enumerates the hosted
document namespace. A debounced filesystem watcher performs responsive
write-back, and the session end-of-turn/disposal sweep performs an explicit
fallback flush. Both use the manifest base version for conditional writes.

A mismatch parks the manifest entry in `conflicted`, preserves the session
file and durable object, and blocks further automatic write-back until an
authenticated human chooses the durable object or the preserved session draft.
Choosing the durable object stores the session draft beside the hydrated file
as a conflict copy before re-hydration; choosing the draft performs a fresh
conditional write from the current durable version. A successful write advances the
base version and durable object before the manifest is updated. Losing the VM
therefore leaves the latest completed write-back durable and loses at most the
documented debounce interval of local edits.

Hosted control-plane hydration uses a short-lived Document Session Token. The
token has the dedicated `document-session-writeback` audience and binds one
organization, project, workspace, session, document, and `document.write`
operation. Its lifetime is at most five minutes. The trusted relay-owned
hydration request delivers it directly to the workspace runtime; the runtime
keeps it in watcher memory and never writes it to the manifest, hydrated file,
tool output, or model context. The runtime rotates the token through the scoped
renewal endpoint before expiry. Renewal accepts only a still-valid token with
the same complete scope.

The runtime accepts hydration only on relay exposure after relay-owner
authentication. Loopback, embedded, and untrusted private-network exposure do
not mount an effective hydration capability. The write-back and renewal URLs
must share the configured Control Plane origin; request-derived Host headers
and caller-selected origins are not authority. Each write-back verifies token
expiry, audience, operation, and every scope dimension before applying the
single-object ETag comparison. A successful callback advances the document
index and publishes `document.changed`; an ETag mismatch preserves the durable
object and parks the session copy as conflicted.

Local managed documents remain authoritative in the installed local app. The
hosted control plane discovers their metadata live through exactly one active
`user-hosted/local-worktree` installation linked to the project; missing,
offline, cross-project, and ambiguous links fail closed. Metadata and bodies
are not copied into hosted object storage. The control plane sends a
`document-relay-job` capability through Workspace Relay, which verifies the
Runtime Access Token and forwards a relay-minted host token plus relay markers
to the local workspace runtime. That runtime verifies the dedicated job
audience and complete user, organization, project, local-workspace,
cloud-workspace, session, document, operation, JTI, and absolute-job-expiry
scope before using its process-retained installation credential to call the
loopback local document broker. The broker reads and conditionally writes the
local managed backend outside the workspace root.

Write-back capabilities rotate JTI on renewal; the previous JTI is revoked.
Renewal reauthorizes current session placement, workspace/project membership,
installation reachability, and document archive state, and never extends the
absolute job expiry. Work Source locators receive an expiring intake lease
before publication. The permanent source/revision pin replaces the lease only
after durable source creation, while GC tombstones remain revivable during a
bounded grace period and establish a final CAS claim before deleting content.

## Security Review

Verdict: approved for the Documents core capability boundary.

The reviewed trust boundary keeps the installation credential inside the
local application and keeps storage credentials outside the agent process.
Every job capability is audience-specific, short-lived, revocable, and bound to
the complete user, organization, project, local workspace, cloud workspace,
session, document, operation, and absolute job expiry. Renewal repeats current
authorization and cannot extend that absolute expiry. Viewer roles can read but
cannot mint or renew a writable capability; editor, admin, and owner roles may
write only within the same verified project and document scope.

The executable negative matrix covers a second document, a second project,
expired tokens, the wrong audience, revoked and superseded JTIs, inactive host
links, viewer write attempts, archived documents, malformed bodies, untrusted
runtime exposure, and missing installation state. Each case fails before local
content access or mutation. Conditional write-back remains the final authority,
so a valid but stale capability cannot overwrite a newer document version.

## Live Local Agent Evidence

At `2026-07-16T19:34Z`, an isolated local `claxedo-server` created real session
`ses_09395da48ffe7oCUCnO7i2EMrb`, created managed document
`document_a0394d16718c403b989cf3816fd3d832`, and granted the session through
`POST /documents/:id/agent-open`. The grant returned the contained ordinary
file at
`.claxedo/sessions/<session-id>/docs/<document-id>/live-agent-contract.md`.

The real embedded OpenCode `build` agent using `opencode/big-pickle` received
that exact path through `POST /session/:id/message`. Its recorded transcript
contains a completed `bash` tool call (`exit: 0`, untruncated) that overwrote
the file with the requested Markdown. The initial canonical bytes were 65
bytes with SHA-256
`8d71b72036b3b0fed13f0915020711b5f1376d889f84722601418e13d0be219f`.
After the tool call and watcher write-back, both the granted file and
`GET /documents/:id/content` returned the exact same 100 bytes with SHA-256
`09903730756ce18fb21bdaf5a38d127eaea2a7e6ecfc0cd2118fe4da6e7c0615`.
The canonical version token advanced and no direct document-specific agent
write API was used.

## Live Cloud VM Relay Evidence

At `2026-07-16T19:47Z`, the reusable
`scripts/smoke/documents-relay-live-harness.ts` composed a real local managed
workspace, installation broker, relay-authenticated Workspace Runtime, and
Workspace Relay. A Cloudflare quick tunnel exposed only the relay endpoint.
Fly Machine `8ed43dc7659328` then ran
`scripts/smoke/documents-relay-cloud-client.sh` in a fresh Alpine 3.20 VM in
region `lhr`.

The VM read `before cloud VM relay\n` from the installed local authority,
conditionally wrote `after cloud VM relay CAS\n`, and attempted a second write
with the stale base version. The client script requires the first write's
version to advance and the stale response to be exactly HTTP 409 before it can
exit successfully. Fly recorded `exit_code=0`, `oom_killed=false`; `--rm`
destroyed the machine immediately afterward. Back on the local authority, the
canonical file was exactly 25 bytes with SHA-256
`05bb94017c7154e12ac5cca128d8cbd5f81332f13adf433a1baa15bdbc029e14`.
The short-lived read, write, and stale-write job capabilities used distinct
JTIs, and the runtime retained the installation credential outside the VM and
model-visible environment. The temporary Fly app and Cloudflare tunnel were
removed after evidence collection.
