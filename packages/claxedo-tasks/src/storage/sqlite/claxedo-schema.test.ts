import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, expect, test } from "bun:test"
import { ClaxedoDB, CLAXEDO_MIGRATION_JOURNAL, configureClaxedoSchema, queryRows, textColumns } from "@claxedo/server-core/platform/db/index"
import { TASKS_SQLITE_SCHEMA } from "./schema"

/**
 * `claxedo.db` as the single host journal builds it while it still holds the
 * Tasks folders, recorded from `dev` at 74370a8: every applied name in order,
 * and the sha256 of its `sqlite_master` rows (163 rows, ordered by type then
 * name, tab-separated `type, name, tbl_name, sql`). A desktop that already
 * applied these names applies nothing new, so its history stays byte-identical.
 */
const RECORDED_NAMES = [
  "20260310000000_initial",
  "20260310000001_file_path",
  "20260320120000_cloud_session",
  "20260320153000_cloud_session_meta",
  "20260320190000_session_meta",
  "20260411000000_provider_credentials",
  "20260411100000_workspace_lease",
  "20260411100001_prepared_image",
  "20260502000100_message_event_ordinal",
  "20260502000200_cloud_message_event_log",
  "20260603000100_hybrid_session_placement",
  "20260610000100_workspace_lease_home_region",
  "20260612000000_pages_org_project",
  "20260613000100_channel_delivery",
  "20260613000200_channel_run_audit",
  "20260627000100_session_navigation_indexes",
  "20260627000200_session_meta_refs",
  "20260702000100_sandbox_driver_credentials",
  "20260702000200_sandbox_driver_columns",
  "20260702000300_cloud_session_driver",
  "20260702000400_terminal_session_driver",
  "20260702000500_session_meta_tool_sandbox",
  "20260703000100_connection",
  "20260710000400_connection_scoping",
  "20260712000100_session_meta_model",
  "20260713000100_docs_v2_additive",
  "20260714000100_page_docs_v2_binding",
  "20260716000100_documents_reset",
  "20260717000100_credential_health",
  "20260717000200_credential_scope",
  "20260724000100_persistent_workspace_lease",
  "20260727000100_drop_living_app",
  "20260728000100_credential_org_scope",
  "20260808000100_usage_turn_ledger",
  "20260809000100_usage_provenance",
  "20260809000200_usage_outbox_tenant",
  "20260809000300_usage_current_settlement_index",
  "20260908000100_custom_provider",
  "20260910000100_session_meta_last_human_turn",
  "20260912000100_session_meta_human_turn_order",
  "20260912000200_credential_active_account",
  "20260912100000_claxedo_tasks",
  "20260913000100_drop_credential_network_grants",
  "20260913000200_credential_revision",
  "20260913000300_credential_usage_windows",
  "20260914000100_credential_activated_at",
  "20260914000200_task_preset_agent_startable",
  "20260914000300_task_session_link_agent_start",
  "20260914000400_task_session_link_started_by",
  "20260914000500_task_attachments",
  "20260915000100_task_child_number",
  "20260920000100_usage_location_machine_placed",
  "20260923000100_usage_cache_write_1h",
  "20260923000200_usage_turn_owner",
  "20260923000300_usage_turn_meter_state",
  "20260925000100_user_agent_config",
  "20260926000000_sandbox_routing_identity",
  "20260928000100_custom_provider_credential_header",
  "20260928000200_provider_account_source",
  "20260930000100_org_account_source",
  "20260930000200_session_meta_runtime_updated_at",
  "20261001000100_document_creator",
  "20261003000100_session_meta_last_turn",
  "20261003000200_session_reads",
  "20261003000300_session_meta_archive_human_turn",
  "20261016000100_usage_turn_credential",
  "20261018000100_credential_secret_hint",
]
const RECORDED_SCHEMA_SHA256 = "8f534eccb4bebb0f17c61fc061d5ad0e84dba919a745a2fb54a99aba33fb0ce3"

const previousDataDir = process.env.CLAXEDO_DATA_DIR
const root = mkdtempSync(path.join(tmpdir(), "claxedo-schema-golden-"))

afterAll(() => {
  ClaxedoDB.close()
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  rmSync(root, { recursive: true, force: true })
})

test("the host journal composed with the Tasks journal builds the recorded schema under the recorded names, in the recorded order", () => {
  process.env.CLAXEDO_DATA_DIR = root
  configureClaxedoSchema({ journals: [CLAXEDO_MIGRATION_JOURNAL, TASKS_SQLITE_SCHEMA.journal] })
  ClaxedoDB.close()
  const sqlite = ClaxedoDB.raw()

  expect(textColumns(queryRows(sqlite, "SELECT name FROM __claxedo_migrations ORDER BY rowid"), "name")).toEqual(RECORDED_NAMES)
  const schema = queryRows(sqlite, "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
    .map((row) => [row.type, row.name, row.tbl_name, row.sql].map((value) => (typeof value === "string" ? value : "")).join("\t"))
    .join("\n")
  expect(createHash("sha256").update(schema).digest("hex")).toBe(RECORDED_SCHEMA_SHA256)
})
