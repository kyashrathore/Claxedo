import { describe, expect, test } from "vitest"
import { claxedoToolHref } from "./claxedo-tool-href"

const scope = { workspaceId: "ws_own", sessionId: "ses_parent" }

describe("Claxedo MCP destinations", () => {
  test("opens the requested process from native and wrapped harness inputs", () => {
    const input = { workspace: "ws_other", process: "web server" }
    const expected = "/w/ws_other?panel=processes&process=web%20server"
    expect(claxedoToolHref("process_logs", input, undefined, scope)).toBe(expected)
    expect(claxedoToolHref("process", { server: "claxedo-mcp", tool: "process", arguments: JSON.stringify(input) }, undefined, scope)).toBe(expected)
    expect(claxedoToolHref("process_start", { server: "claxedo-mcp", tool: "process_start", arguments: input }, undefined, scope)).toBe(expected)
  })

  test("uses authoritative created resource IDs", () => {
    expect(claxedoToolHref("task_create", {}, '{"task":{"id":"task_new"}}', scope)).toBe("/tasks/task_new")
    expect(claxedoToolHref("session_create", {}, '{"id":"ses_new"}', scope)).toBe("/s/ses_new")
    expect(claxedoToolHref("create_subagent", {}, '{"sessionId":"ses_child"}', scope)).toBe("/s/ses_child")
    expect(claxedoToolHref("documents_open", { document: "Notes" }, '{"document":"doc_id"}', scope)).toBe("/w/ws_own/page/doc_id")
    expect(claxedoToolHref("documents_list", { project: "other_project" }, undefined, {
      ...scope, workspaceForDirectory: (ref) => ref === "other_project" ? "other_project" : undefined,
    })).toBe("/w/other_project/page/__index__")
  })

  test("opens existing collection surfaces when no single resource is addressed", () => {
    expect(claxedoToolHref("task_list", {}, undefined, scope)).toBe("/tasks")
    expect(claxedoToolHref("documents_list", {}, undefined, scope)).toBe("/w/ws_own/page/__index__")
    expect(claxedoToolHref("subagent_list", {}, undefined, scope)).toBe("/s/ses_parent")
    expect(claxedoToolHref("sessions_board", {}, undefined, {})).toBe("/")
  })

  test("opens review and attention at their addressed sessions", () => {
    expect(claxedoToolHref("session_changes", { session: "ses_other" }, undefined, scope)).toBe("/s/ses_other?panel=changes")
    expect(claxedoToolHref("permission_reply", { session: "ses_other" }, undefined, scope)).toBe("/s/ses_other")
    expect(claxedoToolHref("workspace_status", { workspace: "ws_other" }, undefined, scope)).toBe("/w/ws_other")
  })

  test("never invents workspace IDs from unresolved directories or broken outputs", () => {
    expect(claxedoToolHref("process_logs", { directory: "/other" }, undefined, scope)).toBeUndefined()
    expect(claxedoToolHref("process_logs", { workspace: "/other" }, undefined, scope)).toBeUndefined()
    expect(claxedoToolHref("documents_open", { document: "Notes" }, "failed", scope)).toBe("/w/ws_own/page/__index__")
    expect(claxedoToolHref("session_delete", { session: "ses_deleted" }, undefined, scope)).toBe("/w/ws_own")
  })
})
