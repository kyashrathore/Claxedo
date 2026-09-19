import { generateKeyPairSync, sign as signData } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { afterEach, describe, expect, test } from "vitest"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { sha256Hex } from "@claxedo/helpers/crypto"
import { MACHINE_REQUEST_HEADERS, machineRequestPayload } from "@claxedo/server-core/platform/auth/host-connect-contract"
import { verifyMachineRequest } from "@claxedo/server-core/platform/auth/machine-auth"
import { createSqliteWorkspaceAuthority } from "./workspace-authority"
import { closeAuthorityDatabases, openAuthorityDb } from "./workspace-authority-store"

/**
 * A database written by the schema as it stood before host-connect (the
 * fixture is that schema's `sqlite_master`, dumped verbatim) is opened by the
 * current store. Every pre-existing row must survive with the defaults its
 * meaning implies, and the upgraded database must behave like a fresh one.
 */

const PRE_SCHEMA = fs.readFileSync(path.join(__dirname, "fixtures", "authority-schema-before-host-connect.sql"), "utf8")
const OWNER = "https://idp.example.test|owner"
const ownerAuth: SignedControlPlaneAuth = {
  mode: "signed",
  token: "tok_owner",
  user: { subject: "owner", tokenIdentifier: OWNER, issuer: "https://idp.example.test" },
}

const roots: string[] = []

afterEach(() => {
  closeAuthorityDatabases()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const liveKeys = generateKeyPairSync("ec", { namedCurve: "P-256" })
const LIVE_PUBLIC_KEY = JSON.stringify(liveKeys.publicKey.export({ format: "jwk" }))

function preConnectDatabase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-host-connect-upgrade-"))
  roots.push(root)
  const file = path.join(root, "authority.db")
  const legacy = new Database(file)
  legacy.exec(PRE_SCHEMA)
  legacy.exec(`
    INSERT INTO users (token_identifier, public_id, subject, issuer, name, kind, created_at, updated_at)
    VALUES ('${OWNER}', 'usr_owner', 'owner', 'https://idp.example.test', 'Owner', 'human', 1, 1);
    INSERT INTO orgs (org_id, name, kind, owner_token_identifier, created_at, updated_at)
    VALUES ('org_personal', 'Personal', 'personal', '${OWNER}', 1, 1);
    INSERT INTO org_memberships (org_id, token_identifier, role, created_at, updated_at)
    VALUES ('org_personal', '${OWNER}', 'owner', 1, 1);
    INSERT INTO projects (project_id, org_id, repo_key, owner_token_identifier, created_at, updated_at)
    VALUES ('prj_one', 'org_personal', 'workspace:ws_served', '${OWNER}', 1, 1);
    INSERT INTO workspaces
      (workspace_id, org_id, project_id, owner_token_identifier, backing, access, display_name, remote_directory, created_at, updated_at)
    VALUES
      ('ws_served', 'org_personal', 'prj_one', '${OWNER}', 'local-worktree', 'user-hosted', 'Served', '/srv/app', 1, 1),
      ('ws_idle', 'org_personal', 'prj_one', '${OWNER}', 'local-worktree', 'user-hosted', 'Idle', '/srv/idle', 1, 1);
    INSERT INTO host_enrollments
      (enrollment_id, owner_token_identifier, host_id, public_key, display_name, last_seen_at, expires_at,
       acked_workspace_ids, acked_at, session_authority, created_at, updated_at)
    VALUES
      ('enr_live', '${OWNER}', 'host_live', '${LIVE_PUBLIC_KEY}', 'Laptop', 10, 9999999999999,
       '["ws_served"]', 10, 'local', 1, 10),
      ('enr_gone', '${OWNER}', 'host_gone', '{"kty":"EC","x":"d8G4ztG-BPnZGPCRYEIfDQkaumIJ7nd-s1ZBl-g9Ixg","y":"R7hTtfOyLYmoVtTn2Hno_i2mjSmiNtUBT7oiyPS8YNI","crv":"P-256"}', 'Old laptop', 5, 6,
       NULL, NULL, NULL, 1, 5);
    UPDATE host_enrollments SET revoked_at = 7 WHERE enrollment_id = 'enr_gone';
    INSERT INTO host_workspace_assignments
      (workspace_id, host_id, owner_token_identifier, second_device_open_at, assigned_at, updated_at)
    VALUES
      ('ws_served', 'host_live', '${OWNER}', 3, 2, 2),
      ('ws_idle', 'host_live', '${OWNER}', NULL, 2, 2);
    INSERT INTO session_registration_operations
      (operation_id, session_id, workspace_id, creator_actor_id, operation_kind, state, created_at, updated_at)
    VALUES ('op_1', 'ses_1', 'ws_served', '${OWNER}', 'create', 'registered', 1, 1);
    INSERT INTO session_history
      (session_id, workspace_id, creator_actor_id, operation_id, title, created_at, updated_at)
    VALUES ('ses_1', 'ws_served', '${OWNER}', 'op_1', 'First', 1, 1);
    INSERT INTO session_participants
      (session_id, workspace_id, participant_actor_id, added_by_actor_id, created_at)
    VALUES ('ses_1', 'ws_served', '${OWNER}', '${OWNER}', 1);
  `)
  legacy.close()
  return file
}

function columns(db: InstanceType<typeof Database>, table: string) {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name)
}

describe("SQLite host-connect upgrade", () => {
  test("the fixture is the pre-connect schema: no connect columns or tables", () => {
    const db = new Database(":memory:")
    db.exec(PRE_SCHEMA)
    expect(columns(db, "host_enrollments")).not.toContain("key_version")
    expect(columns(db, "host_workspace_assignments")).not.toContain("revision")
    expect(columns(db, "workspaces")).not.toContain("org_member_visible")
    expect(columns(db, "workspaces")).not.toContain("host_assignment_revision")
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('host_invitations', 'host_request_nonces', 'host_assignment_readiness')`).all())
      .toEqual([])
    db.close()
  })

  test("existing enrollments, assignments and session ownership survive with the implied defaults", () => {
    const file = preConnectDatabase()
    const db = openAuthorityDb({ path: file })()

    expect(db.prepare(`
      SELECT enrollment_id, host_id, revoked_at, key_version, serving_generation, generation_acquired_at,
        enrolled_via, scope_json, scope_revision, acked_workspace_ids, session_authority
      FROM host_enrollments ORDER BY enrollment_id
    `).all()).toEqual([
      {
        enrollment_id: "enr_gone", host_id: "host_gone", revoked_at: 7,
        key_version: 1, serving_generation: 0, generation_acquired_at: null,
        enrolled_via: "account", scope_json: null, scope_revision: 0,
        acked_workspace_ids: null, session_authority: null,
      },
      {
        enrollment_id: "enr_live", host_id: "host_live", revoked_at: null,
        key_version: 1, serving_generation: 0, generation_acquired_at: null,
        enrolled_via: "account", scope_json: null, scope_revision: 0,
        acked_workspace_ids: '["ws_served"]', session_authority: "local",
      },
    ])
    expect(db.prepare(`
      SELECT workspace_id, host_id, revision, second_device_open_at FROM host_workspace_assignments ORDER BY workspace_id
    `).all()).toEqual([
      { workspace_id: "ws_idle", host_id: "host_live", revision: 1, second_device_open_at: null },
      { workspace_id: "ws_served", host_id: "host_live", revision: 1, second_device_open_at: 3 },
    ])
    expect(db.prepare(`SELECT workspace_id, org_member_visible, remote_directory, host_assignment_revision FROM workspaces ORDER BY workspace_id`).all())
      .toEqual([
        { workspace_id: "ws_idle", org_member_visible: 1, remote_directory: "/srv/idle", host_assignment_revision: 1 },
        { workspace_id: "ws_served", org_member_visible: 1, remote_directory: "/srv/app", host_assignment_revision: 1 },
      ])
    expect(db.prepare(`SELECT session_id, creator_actor_id, operation_id FROM session_history`).all())
      .toEqual([{ session_id: "ses_1", creator_actor_id: OWNER, operation_id: "op_1" }])
    expect(db.prepare(`SELECT session_id, participant_actor_id FROM session_participants`).all())
      .toEqual([{ session_id: "ses_1", participant_actor_id: OWNER }])
    for (const table of ["host_invitations", "host_request_nonces", "host_assignment_readiness"]) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 })
    }
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'host_request_nonces_by_expires_at'`).get())
      .toEqual({ name: "host_request_nonces_by_expires_at" })
  })

  test("the upgraded database has exactly the columns a fresh one has, and reopening changes nothing", () => {
    const file = preConnectDatabase()
    const upgraded = openAuthorityDb({ path: file })()
    const fresh = openAuthorityDb({ path: ":memory:" })()
    for (const table of ["host_enrollments", "host_workspace_assignments", "workspaces", "host_invitations", "host_request_nonces", "host_assignment_readiness"]) {
      expect(columns(upgraded, table).sort()).toEqual(columns(fresh, table).sort())
    }
    const before = upgraded.prepare(`SELECT * FROM host_enrollments ORDER BY enrollment_id`).all()
    closeAuthorityDatabases()
    const reopened = openAuthorityDb({ path: file })()
    expect(reopened.prepare(`SELECT * FROM host_enrollments ORDER BY enrollment_id`).all()).toEqual(before)
  })

  test("a pre-connect enrollment has no sealing key and no pushed configuration, exactly as a fresh one", async () => {
    const file = preConnectDatabase()
    const db = openAuthorityDb({ path: file })()
    const columns = `sealing_public_key_json, provider_config_sealed, provider_config_revision, provider_config_acked_revision, provider_config_updated_at`
    const upgraded = db.prepare(`SELECT ${columns} FROM host_enrollments WHERE enrollment_id = 'enr_live'`).get()
    expect(upgraded).toEqual({
      sealing_public_key_json: null,
      provider_config_sealed: null,
      provider_config_revision: 0,
      provider_config_acked_revision: 0,
      provider_config_updated_at: null,
    })

    const freshFile = path.join(path.dirname(file), "fresh.db")
    const fresh = createSqliteWorkspaceAuthority({ path: freshFile })
    const request = await fresh.createHostEnrollmentRequest(ownerAuth, { hostId: "host_live" })
    const payload = ["claxedo.host-enrollment.enroll.v1", "host_id=host_live", `request_id=${request.request_id}`, `nonce=${request.nonce}`].join("\n")
    await fresh.enrollHost(ownerAuth, {
      hostId: "host_live",
      publicKey: LIVE_PUBLIC_KEY,
      requestId: request.request_id,
      signature: signData("sha256", Buffer.from(payload), { key: liveKeys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url"),
    })
    expect(openAuthorityDb({ path: freshFile })().prepare(`SELECT ${columns} FROM host_enrollments WHERE host_id = 'host_live'`).get())
      .toEqual(upgraded)

    const api = createSqliteWorkspaceAuthority({ path: file })
    expect(await api.listHostEnrollments!(ownerAuth)).toMatchObject([
      { enrollment_id: "enr_live", provider_config_revision: 0, provider_config_acked_revision: 0, sealing_key_declared: false },
    ])
    expect(await api.hostProviderConfigTarget!(ownerAuth, { enrollmentId: "enr_live" }))
      .toEqual({ enrollment_id: "enr_live", host_id: "host_live", display_name: "Laptop", sealing_public_key: null, next_revision: 1 })
  })

  test("the revision counter starts at the revision a connect-era database already issued", async () => {
    // A database from before the counter existed but after assignments carried
    // revisions: its live assignment is at 4, so the next re-point must be 5.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-host-connect-upgrade-"))
    roots.push(root)
    const file = path.join(root, "authority.db")
    const api = createSqliteWorkspaceAuthority({ path: file })
    const request = await api.createHostEnrollmentRequest(ownerAuth, { hostId: "host_live" })
    const payload = ["claxedo.host-enrollment.enroll.v1", "host_id=host_live", `request_id=${request.request_id}`, `nonce=${request.nonce}`].join("\n")
    await api.enrollHost(ownerAuth, {
      hostId: "host_live",
      publicKey: LIVE_PUBLIC_KEY,
      requestId: request.request_id,
      signature: signData("sha256", Buffer.from(payload), { key: liveKeys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url"),
    })
    await api.assignWorkspaceHost(ownerAuth, { workspaceId: "ws_a", hostId: "host_live", remoteDirectory: "/srv/a" })
    await api.assignWorkspaceHost(ownerAuth, { workspaceId: "ws_b", hostId: "host_live", remoteDirectory: "/srv/b" })
    await api.unassignWorkspaceHost(ownerAuth, { workspaceId: "ws_b" })
    const db = openAuthorityDb({ path: file })()
    db.exec(`
      ALTER TABLE workspaces DROP COLUMN host_assignment_revision;
      UPDATE host_workspace_assignments SET revision = 4 WHERE workspace_id = 'ws_a';
    `)
    closeAuthorityDatabases()

    const upgraded = openAuthorityDb({ path: file })()
    expect(upgraded.prepare(`SELECT workspace_id, host_assignment_revision FROM workspaces ORDER BY workspace_id`).all())
      .toEqual([{ workspace_id: "ws_a", host_assignment_revision: 4 }, { workspace_id: "ws_b", host_assignment_revision: 0 }])
    await api.assignWorkspaceHost(ownerAuth, { workspaceId: "ws_a", hostId: "host_live", remoteDirectory: "/srv/a-moved" })
    expect(upgraded.prepare(`SELECT revision FROM host_workspace_assignments WHERE workspace_id = 'ws_a'`).get()).toEqual({ revision: 5 })
  })

  test("a boot interrupted between the counter column and its backfill is repaired on the next open, never lowering", async () => {
    // The column exists (the ADD COLUMN committed) but every counter is 0
    // while ws_a is served at revision 7; ws_b's counter of 5 outlives its
    // unassigned row and must stay 5.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-host-connect-upgrade-"))
    roots.push(root)
    const file = path.join(root, "authority.db")
    const api = createSqliteWorkspaceAuthority({ path: file })
    const request = await api.createHostEnrollmentRequest(ownerAuth, { hostId: "host_live" })
    const payload = ["claxedo.host-enrollment.enroll.v1", "host_id=host_live", `request_id=${request.request_id}`, `nonce=${request.nonce}`].join("\n")
    await api.enrollHost(ownerAuth, {
      hostId: "host_live",
      publicKey: LIVE_PUBLIC_KEY,
      requestId: request.request_id,
      signature: signData("sha256", Buffer.from(payload), { key: liveKeys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url"),
    })
    await api.assignWorkspaceHost(ownerAuth, { workspaceId: "ws_a", hostId: "host_live", remoteDirectory: "/srv/a" })
    await api.assignWorkspaceHost(ownerAuth, { workspaceId: "ws_b", hostId: "host_live", remoteDirectory: "/srv/b" })
    await api.unassignWorkspaceHost(ownerAuth, { workspaceId: "ws_b" })
    const db = openAuthorityDb({ path: file })()
    db.exec(`
      UPDATE host_workspace_assignments SET revision = 7 WHERE workspace_id = 'ws_a';
      UPDATE workspaces SET host_assignment_revision = 0 WHERE workspace_id = 'ws_a';
      UPDATE workspaces SET host_assignment_revision = 5 WHERE workspace_id = 'ws_b';
    `)
    closeAuthorityDatabases()

    const repaired = openAuthorityDb({ path: file })()
    expect(repaired.prepare(`SELECT workspace_id, host_assignment_revision FROM workspaces ORDER BY workspace_id`).all())
      .toEqual([{ workspace_id: "ws_a", host_assignment_revision: 7 }, { workspace_id: "ws_b", host_assignment_revision: 5 }])
    await api.assignWorkspaceHost(ownerAuth, { workspaceId: "ws_a", hostId: "host_live", remoteDirectory: "/srv/a-moved" })
    expect(repaired.prepare(`SELECT revision FROM host_workspace_assignments WHERE workspace_id = 'ws_a'`).get()).toEqual({ revision: 8 })
    await api.assignWorkspaceHost(ownerAuth, { workspaceId: "ws_b", hostId: "host_live", remoteDirectory: "/srv/b-again" })
    expect(repaired.prepare(`SELECT revision FROM host_workspace_assignments WHERE workspace_id = 'ws_b'`).get()).toEqual({ revision: 6 })
  })

  test("a legacy user-hosted directory is stored normalized after the open; cloud rows are untouched", () => {
    const file = preConnectDatabase()
    const legacy = new Database(file)
    legacy.exec(`
      UPDATE workspaces SET remote_directory = '/srv/app/../app/./' WHERE workspace_id = 'ws_served';
      INSERT INTO workspaces
        (workspace_id, org_id, project_id, owner_token_identifier, backing, access, display_name, remote_directory, created_at, updated_at)
      VALUES ('ws_cloud', 'org_personal', 'prj_one', '${OWNER}', 'cloud-vm', 'cloud', 'Cloud', '/workspace/', 1, 1);
    `)
    legacy.close()
    const upgraded = openAuthorityDb({ path: file })()
    expect(upgraded.prepare(`SELECT workspace_id, remote_directory FROM workspaces ORDER BY workspace_id`).all()).toEqual([
      { workspace_id: "ws_cloud", remote_directory: "/workspace/" },
      { workspace_id: "ws_idle", remote_directory: "/srv/idle" },
      { workspace_id: "ws_served", remote_directory: "/srv/app" },
    ])
  })

  test("a pre-connect acked set no longer routes on its own; the next machine beat re-establishes readiness", async () => {
    // The acked-set column was the routing fact before readiness rows
    // existed. An upgraded row keeps the column but has no readiness row, so
    // the workspace reads offline until the machine beats again — the same
    // one-beat gap a restart already has. Nothing is fabricated at upgrade.
    const file = preConnectDatabase()
    const api = createSqliteWorkspaceAuthority({ path: file })
    const online = async () => Object.fromEntries(
      (await api.listWorkspaces(ownerAuth) as Array<{ workspace_id: string; host_online?: boolean }>)
        .map((row) => [row.workspace_id, row.host_online]),
    )
    expect(await api.activeWorkspaceHost(ownerAuth, { workspaceId: "ws_served" })).toEqual({ active: false })
    expect(await online()).toEqual({ ws_idle: false, ws_served: false })
    expect(await api.listHostEnrollments!(ownerAuth)).toMatchObject([
      { enrollment_id: "enr_live", host_id: "host_live", key_version: 1, enrolled_via: "account", serving_generation: 0, acked: [], scope: undefined },
    ])

    // Through the verifier, not around it: the upgraded row has to admit a
    // machine caller off the public key and key version the upgrade defaulted.
    const body = {
      enrollmentId: "enr_live",
      hostId: "host_live",
      generation: 0,
      acks: [{ workspaceId: "ws_served", revision: 1 }],
    }
    const bodyText = JSON.stringify(body)
    const ts = Date.now()
    const nonce = `nonce_${"0".repeat(12)}`
    const headers = new Map<string, string>([
      [MACHINE_REQUEST_HEADERS.enrollmentId, body.enrollmentId],
      [MACHINE_REQUEST_HEADERS.ts, String(ts)],
      [MACHINE_REQUEST_HEADERS.nonce, nonce],
      [MACHINE_REQUEST_HEADERS.signature, signData("sha256", Buffer.from(machineRequestPayload({
        method: "POST",
        pathname: "/api/claxedo/host/enrollments/heartbeat",
        bodySha256Hex: await sha256Hex(bodyText),
        ts,
        nonce,
        enrollmentId: body.enrollmentId,
      })), { key: liveKeys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")],
    ])
    const verified = await verifyMachineRequest({
      method: "POST",
      pathname: "/api/claxedo/host/enrollments/heartbeat",
      headers: { get: (name: string) => headers.get(name) ?? null },
      bodyText,
    }, { ...api.machineAuth!, now: Date.now })
    if (!verified.ok) throw new Error(`verifier refused the upgraded enrollment: ${verified.code}`)
    const beat = await api.heartbeatHostEnrollmentByMachine!(verified.machine, body)
    expect(beat.assigned_workspace_ids).toEqual(["ws_idle", "ws_served"])
    expect(await api.activeWorkspaceHost(ownerAuth, { workspaceId: "ws_served" })).toMatchObject({ active: true, host_id: "host_live" })
    expect(await online()).toEqual({ ws_idle: false, ws_served: true })
    expect(await api.listHostEnrollments!(ownerAuth)).toMatchObject([
      { enrollment_id: "enr_live", acked: [{ workspaceId: "ws_served", revision: 1 }] },
    ])
  })
})
