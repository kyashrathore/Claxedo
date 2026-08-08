# Host enrollment hard cut

Remote access moves from **per-workspace host links** to **one enrollment per
machine**. This runbook is the only supported way to perform that move on a live
deployment.

Owners: the control-plane release operator runs every phase below. The desktop
release owner publishes the matching desktop build, and only at the point marked
for it.

## Why a hard cut

Both designs answer "may this machine reach this workspace right now". Running
them together means two writers to one piece of state, and a session admitted by
one while the other believes it is paused. The repo's rule against dual paths
applies with more force here than usual: the failure is not a stale UI, it is
access.

So there is no compatibility mode and no dual-read. `retire-legacy` deletes the
old rows, and after it there is no rollback — see [After retirement](#after-retirement).

## Phases

Run from `packages/claxedo-server`:

```bash
bun run maintenance:cutover-host-enrollments -- <phase> --environment <environment> --sha <sha>
```

Phases must run in order. The script records a cutover id bound to the
deployment and SHA, and refuses a phase whose predecessor did not complete for
that same id — so a half-finished cutover cannot be resumed against a different
build.

| Phase | What it does | Reversible |
|---|---|---|
| `preflight` | Counts legacy rows, checks the new schema is deployed, verifies no unexpected writers. Changes nothing. | n/a |
| `enter-maintenance` | Blocks legacy host-link creation, renewal and connection mint; drains and closes host publication. | Yes — `exit-maintenance` |
| `retire-legacy` | Deletes the legacy rows. **Irreversible.** | **No** |
| `verify-retirement` | Proves the legacy rows are gone and nothing recreated them. Idempotent; safe to rerun. | n/a |
| `verify-new` | Proves zero-workspace enrollment plus Bun and Cloudflare add/remove/reconnect. | n/a |
| `exit-maintenance` | Restores normal operation on the new authority. | n/a |

Every phase writes commands, actor, timestamps, counts and evidence to the
cutover record.

## `retire-legacy` defaults to a dry run

`retire-legacy` **reports what it would delete and deletes nothing** unless you
pass the destructive flag:

```bash
bun run maintenance:cutover-host-enrollments -- retire-legacy \
  --environment production --sha <sha> --confirm-destroy
```

Without `--confirm-destroy` the phase runs its preconditions, counts the rows,
writes the audit record, and exits reporting `dry-run`. It does not advance the
cutover state, so `verify-retirement` will refuse to run after it.

This default exists because the phase is irreversible, acts on a live
deployment, and the flag is the only place a human decision is recorded. A
destructive default would make "I ran the runbook to see what it does" a
production incident.

Before passing the flag, confirm by hand that no old Hosted Server or Relay
writer remains. `enter-maintenance` blocks the API paths; it cannot prove that
an older deployment of the server is not still running somewhere. That
confirmation is the operator's, and the script asks for it.

## Deployment order

1. `preflight` — on the reviewed SHA.
2. `enter-maintenance`.
3. Prove the old Hosted Server and Relay writers are drained.
4. `retire-legacy --confirm-destroy`.
5. `verify-retirement`.
6. Deploy that same SHA's Convex schema and functions, plus the Hosted Server
   and Relay artifacts, through the existing control-plane workflow.
7. `verify-new`.
8. **Desktop release owner** publishes that SHA's OAuth/account adapter and Host
   Connector — after `verify-new`, not before.
9. `exit-maintenance`.

The schema, functions, server, relay and desktop build must all be the same
reviewed SHA. A mixed set is how the two authorities end up live at once, which
is the exact state this document exists to avoid.

## Before retirement

Aborting is safe. Run `exit-maintenance` and the old deployment is unchanged.

## After retirement

There is no rollback and no compatibility mode. If something is wrong after
`retire-legacy`:

- Keep Remote Access in maintenance.
- Local desktop work and cloud-VM work stay available throughout, and are not
  part of this window.
- Fix forward: redeploy the corrected SHA, rerun `verify-retirement` (it is
  idempotent), then `verify-new`.
- Only `exit-maintenance` once `verify-new` passes.

Restoring the legacy authority is not an option the tooling offers. The rows are
gone, and a partial restore would put both authorities back in front of the same
access decision.

## Self-hosted (SQLite)

Self-hosted deployments perform the equivalent cut transactionally on the first
boot of the new composition, and preserve a pre-migration backup according to the
existing SQLite migration policy. That path never starts the old composition and
never restores legacy sharing authority — the same one-authority rule, enforced
by there being only one code path to boot.

## Related

- `convex/hostEnrollments.ts` and the SQLite authority implement the new tables.
- `docs/tech-docs/desktop-hosted-operation-matrix.md` names
  `host.enrollCurrentMachine`, the one operation the renderer may ask for.
- `convex/orgs.ts` records why org deletion retains enrollments rather than
  purging them.
