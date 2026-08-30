# Tenant identity schema rollout

This rollout moves durable authority records to explicit actor, organization,
project, and session provenance. Convex follows an expand–migrate–contract
sequence across every deployment. SQLite performs the equivalent upgrade in a
single local transaction and retains a pre-upgrade snapshot.

## Data inventory and mappings

| Table | Fields established | Stored provenance used |
| --- | --- | --- |
| `users` | `public_id`, `kind` | Existing values; otherwise a new opaque `usr_…` identifier and `human` for a legacy signed-user row |
| `projects` | `project_id`, `org_id`, `repo_key`, `owner_user_id`, snake-case timestamps | Existing snake-case values, legacy `externalId` / `organizationId` / `repoUrl`, then the single stored owner organization when uniquely determined |
| `project_memberships` | public `project_id` | The referenced project document's migrated public id |
| `workspaces` | `org_id`, public `project_id` | Existing project organization, then the owner's single stored organization; a missing project is created with deterministic identity |
| `session_history` | `org_id`, public `project_id`, `created_by_user_id` | The authoritative workspace and its owner for a legacy session |

Legacy camel-case project fields remain present through the expand and migrate
releases. Ambiguous organization, owner, duplicate public-id, and duplicate
repository mappings stop the affected migration batch with the row ids in the
error. The operator resolves the stored provenance and reruns the same command;
the component resumes from its durable cursor.

## Convex deployment sequence

Record the expand release SHA and keep the command output with the deployment
change record:

```sh
git rev-parse HEAD
npx convex deploy --dry-run
npx convex deploy --message "expand tenant identity schema"
```

The first deployment contains the optional compatibility schema, current
dual-writing code, migration definitions, and contract probes. It is deployed
without the required-field contract.

### Pre-migration verification

Capture the existing migration ledger and a bounded sample of incomplete rows.
Run once against staging and once against production by substituting
`--deployment staging` with `--prod`:

```sh
npx convex run --component migrations lib:getStatus --deployment staging
npx convex run --inline-query 'const users = await ctx.db.query("users").filter(q => q.or(q.eq(q.field("public_id"), undefined), q.eq(q.field("kind"), undefined))).take(20); const projects = await ctx.db.query("projects").filter(q => q.or(q.eq(q.field("project_id"), undefined), q.eq(q.field("org_id"), undefined), q.eq(q.field("repo_key"), undefined), q.eq(q.field("owner_user_id"), undefined))).take(20); const workspaces = await ctx.db.query("workspaces").filter(q => q.or(q.eq(q.field("org_id"), undefined), q.eq(q.field("project_id"), undefined))).take(20); const sessions = await ctx.db.query("session_history").filter(q => q.or(q.eq(q.field("org_id"), undefined), q.eq(q.field("project_id"), undefined), q.eq(q.field("created_by_user_id"), undefined))).take(20); return {users: users.map(r => ({id:r._id, token_identifier:r.token_identifier, public_id:r.public_id, kind:r.kind})), projects: projects.map(r => ({id:r._id, project_id:r.project_id, externalId:r.externalId, org_id:r.org_id, organizationId:r.organizationId, repo_key:r.repo_key, owner_user_id:r.owner_user_id})), workspaces: workspaces.map(r => ({id:r._id, workspace_id:r.workspace_id, org_id:r.org_id, project_id:r.project_id, owner_user_id:r.owner_user_id})), sessions: sessions.map(r => ({id:r._id, session_id:r.session_id, workspace_id:r.workspace_id, org_id:r.org_id, project_id:r.project_id, created_by_user_id:r.created_by_user_id}))}' --deployment staging
```

The bounded sample is an operator aid. The ledger-backed contract probes below
are the complete, batched enumeration.

### Backfill

Run the dependency-ordered chain on staging:

```sh
npx convex run migrations:run '{"fn":"migrations:backfillUserActorIdentity","next":["migrations:backfillProjectTenantIdentity","migrations:reconcileProjectMembershipProjectIds","migrations:backfillWorkspaceTenantIdentity","migrations:backfillSessionTenantIdentity"],"reset":true}' --deployment staging
bun scripts/wait-for-convex-migrations.ts --deployment staging migrations:backfillUserActorIdentity migrations:backfillProjectTenantIdentity migrations:reconcileProjectMembershipProjectIds migrations:backfillWorkspaceTenantIdentity migrations:backfillSessionTenantIdentity
```

After staging verification succeeds, run the same chain on production:

```sh
npx convex run migrations:run '{"fn":"migrations:backfillUserActorIdentity","next":["migrations:backfillProjectTenantIdentity","migrations:reconcileProjectMembershipProjectIds","migrations:backfillWorkspaceTenantIdentity","migrations:backfillSessionTenantIdentity"],"reset":true}' --prod
bun scripts/wait-for-convex-migrations.ts --prod migrations:backfillUserActorIdentity migrations:backfillProjectTenantIdentity migrations:reconcileProjectMembershipProjectIds migrations:backfillWorkspaceTenantIdentity migrations:backfillSessionTenantIdentity
```

### Complete post-migration verification

Run the batched contract probes on each deployment:

```sh
npx convex run migrations:run '{"fn":"migrations:verifyUserActorIdentityContract","next":["migrations:verifyProjectTenantIdentityContract","migrations:verifyProjectMembershipIdentityContract","migrations:verifyWorkspaceTenantIdentityContract","migrations:verifySessionTenantIdentityContract"],"reset":true}' --deployment staging
bun scripts/wait-for-convex-migrations.ts --deployment staging migrations:verifyUserActorIdentityContract migrations:verifyProjectTenantIdentityContract migrations:verifyProjectMembershipIdentityContract migrations:verifyWorkspaceTenantIdentityContract migrations:verifySessionTenantIdentityContract
npx convex run migrations:run '{"fn":"migrations:verifyUserActorIdentityContract","next":["migrations:verifyProjectTenantIdentityContract","migrations:verifyProjectMembershipIdentityContract","migrations:verifyWorkspaceTenantIdentityContract","migrations:verifySessionTenantIdentityContract"],"reset":true}' --prod
bun scripts/wait-for-convex-migrations.ts --prod migrations:verifyUserActorIdentityContract migrations:verifyProjectTenantIdentityContract migrations:verifyProjectMembershipIdentityContract migrations:verifyWorkspaceTenantIdentityContract migrations:verifySessionTenantIdentityContract
npx convex run --component migrations lib:getStatus --deployment staging
npx convex run --component migrations lib:getStatus --prod
```

Every rollout uses `reset: true` so a previously completed ledger entry cannot
hide legacy rows introduced since the prior deployment. The waiter polls the
component ledger until every dependency-ordered entry reaches terminal success;
the smoke and publication steps do not start while a later batch is still
scheduled or running.

The release record must show `isDone: true`, no error, and a processed count for
all ten tenant-identity migration and verification entries on both deployments.
The five verification entries enumerate every row through the component's
batched cursor, including tables larger than a single Convex transaction.

The normal staging and production path enforces this sequence in
`.github/workflows/deploy-control-plane.yml`: after Convex expands, it runs the
five dependency-ordered backfills, all five verification scans, and a retained
legacy Session canary before publishing either the workspace relay or control
plane Worker. Configure `TENANT_MIGRATION_LEGACY_SESSION_ID` in both GitHub
environments to a durable pre-rollout Session. A missing canary, a Session whose
organization/project no longer equals its workspace, or any incomplete scan
stops publication.

### Rollback and contract

The expand release is the rollback target. Re-deploy its recorded SHA if a
dependent application release needs to be reverted:

```sh
git switch --detach <EXPAND_RELEASE_SHA>
npx convex deploy --message "restore tenant identity expand release"
```

This rollback leaves migrated values in place and remains schema-compatible;
legacy project fields are still available to the expand code. A failed batch is
fixed forward by correcting its reported row and rerunning the backfill chain.

The contract is a separate Convex-only release. It may make the migrated fields
required and remove legacy project fields only after the staging and production
status outputs above are attached to the change record. Validate and deploy it
with:

```sh
npx convex deploy --dry-run
npx convex deploy --message "contract tenant identity schema"
```

## SQLite local upgrade

`openAuthorityDb` checkpoints WAL, creates
`authority.db.pre-tenancy-v3.bak`, backfills in a transaction, validates nulls
and duplicate identities, rebuilds the three affected tables, creates parity
indexes, and sets `PRAGMA user_version = 3`. An ambiguity rolls the transaction
back and reports the exact workspace or project id.

Before starting the upgraded service, capture the legacy shape:

```sh
AUTHORITY_DB=/absolute/path/to/authority.db
sqlite3 "$AUTHORITY_DB" 'PRAGMA integrity_check; PRAGMA user_version; SELECT COUNT(*) AS users FROM users; SELECT COUNT(*) AS projects FROM projects; SELECT COUNT(*) AS workspaces FROM workspaces;'
sqlite3 "$AUTHORITY_DB" '.schema users' '.schema projects' '.schema workspaces'
```

After one successful start, verify the complete local dataset:

```sh
AUTHORITY_DB=/absolute/path/to/authority.db
sqlite3 "$AUTHORITY_DB" 'PRAGMA integrity_check; PRAGMA user_version; SELECT COUNT(*) FROM users WHERE public_id IS NULL OR trim(public_id) = ""; SELECT COUNT(*) FROM projects WHERE org_id IS NULL OR repo_key IS NULL OR owner_token_identifier IS NULL; SELECT COUNT(*) FROM workspaces WHERE org_id IS NULL OR project_id IS NULL; SELECT org_id, repo_key, COUNT(*) FROM projects GROUP BY org_id, repo_key HAVING COUNT(*) > 1;'
sqlite3 "$AUTHORITY_DB" '.schema users' '.schema projects' '.schema workspaces'
test -f "$AUTHORITY_DB.pre-tenancy-v3.bak"
```

The integrity result is `ok`, the user version is `3`, every null/blank count is
`0`, and the duplicate query has no rows.

For local rollback, stop the service and preserve both the failed upgraded file
and its WAL sidecars before restoring the snapshot:

```sh
AUTHORITY_DB=/absolute/path/to/authority.db
mv "$AUTHORITY_DB" "$AUTHORITY_DB.failed-v3"
test ! -f "$AUTHORITY_DB-wal" || mv "$AUTHORITY_DB-wal" "$AUTHORITY_DB-wal.failed-v3"
test ! -f "$AUTHORITY_DB-shm" || mv "$AUTHORITY_DB-shm" "$AUTHORITY_DB-shm.failed-v3"
cp "$AUTHORITY_DB.pre-tenancy-v3.bak" "$AUTHORITY_DB"
sqlite3 "$AUTHORITY_DB" 'PRAGMA integrity_check;'
```

The restored database is opened only by the expand-compatible application
release. The failed-v3 files remain available for diagnosis and forward repair.
