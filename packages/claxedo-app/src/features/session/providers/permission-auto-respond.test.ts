import { describe, expect, test } from "bun:test"
import { ACP_DANGER_TOOL_KINDS, CLAXEDO_AUTO_ANSWERS } from "@/features/session/permission/modes"
import {
  autoResponseOwnsPermission,
  autoRespondsPermission,
  autoRespondablePermissions,
  directoryAcceptKey,
  isAutoApprovablePermission,
  isDirectoryAutoAccepting,
  permissionRequestPolicyReady,
  reconcileAutoPermissionRequests,
  acceptKey,
} from "./permission-auto-respond"

const DIR = "/work/project"
const SESSION = "ses_1"

const onFor = (sessionID: string) => ({ [acceptKey(sessionID, DIR)]: true })
const onForDirectory = () => ({ [directoryAcceptKey(DIR)]: true })

describe("isAutoApprovablePermission", () => {
  // Regression guard: `CLAXEDO_AUTO_ANSWERS` DESCRIBES what Auto approves and this
  // function DECIDES it. They drifted once — `question` was in the constant and
  // missing from the decision — so the documented behaviour and the running
  // behaviour disagreed. Pin them to the same set.
  test("approves exactly the set CLAXEDO_AUTO_ANSWERS advertises", () => {
    for (const key of CLAXEDO_AUTO_ANSWERS) {
      expect(isAutoApprovablePermission(key)).toBe(true)
    }
    const advertised = new Set<string>(CLAXEDO_AUTO_ANSWERS)
    for (const key of ["bash", "webfetch", "external_directory", "task", "skill", "doom_loop", "websearch"]) {
      expect(advertised.has(key)).toBe(false)
      expect(isAutoApprovablePermission(key)).toBe(false)
    }
  })

  // ACP harnesses send the protocol's `ToolKind`, not opencode's permission keys.
  // Before `toolCall.kind` was forwarded, `permission` held prose ("Read file
  // src/index.ts") and this matched NOTHING — auto-approve was inert on every ACP
  // harness while all tests passed.
  test("approves ACP's safe ToolKinds", () => {
    for (const kind of ["read", "edit", "search", "think"]) {
      expect(isAutoApprovablePermission(kind)).toBe(true)
    }
  })

  test("never approves ACP's risky ToolKinds", () => {
    for (const kind of ACP_DANGER_TOOL_KINDS) {
      expect(isAutoApprovablePermission(kind)).toBe(false)
    }
  })

  // `delete`/`move` are file operations but must NOT ride along with `edit`, and
  // `other` is the protocol catch-all for an unclassified request.
  test("delete, move and other are excluded even though edit is allowed", () => {
    expect(isAutoApprovablePermission("edit")).toBe(true)
    for (const kind of ["delete", "move", "other"]) {
      expect(isAutoApprovablePermission(kind)).toBe(false)
    }
  })

  test("approves reads and in-project writes", () => {
    for (const key of ["read", "glob", "grep", "list", "lsp", "edit", "todowrite"]) {
      expect(isAutoApprovablePermission(key)).toBe(true)
    }
  })

  test("does not approve anything with blast radius", () => {
    for (const key of ["bash", "webfetch", "websearch", "external_directory", "task", "skill", "doom_loop"]) {
      expect(isAutoApprovablePermission(key)).toBe(false)
    }
  })

  // The allowlist's whole point: opencode's namespace has an open tail (MCP tool
  // names, subagent ids, the shell tool id), so an unrecognised permission must
  // fail SAFE and reach the user rather than being auto-approved.
  test("fails safe on unrecognised and dynamic permission names", () => {
    for (const key of ["mcp__github__create_pr", "some_future_tool", "bash_v2", ""]) {
      expect(isAutoApprovablePermission(key)).toBe(false)
    }
    expect(isAutoApprovablePermission(undefined)).toBe(false)
  })
})

describe("autoRespondsPermission", () => {
  test("answers a safe request when the switch is on for the session", () => {
    expect(autoRespondsPermission(onFor(SESSION), [{ id: SESSION }], { sessionID: SESSION, permission: "read" }, DIR)).toBe(
      true,
    )
  })

  test("leaves a risky request for the user even when the switch is on", () => {
    expect(autoRespondsPermission(onFor(SESSION), [{ id: SESSION }], { sessionID: SESSION, permission: "bash" }, DIR)).toBe(
      false,
    )
  })

  test("answers nothing when the switch is off", () => {
    expect(autoRespondsPermission({}, [{ id: SESSION }], { sessionID: SESSION, permission: "read" }, DIR)).toBe(false)
  })

  test("a directory-level switch covers sessions in that directory", () => {
    expect(
      autoRespondsPermission(onForDirectory(), [{ id: SESSION }], { sessionID: SESSION, permission: "edit" }, DIR),
    ).toBe(true)
    expect(isDirectoryAutoAccepting(onForDirectory(), DIR)).toBe(true)
  })

  test("inherits the switch from a parent session", () => {
    const sessions = [{ id: "child", parentID: SESSION }, { id: SESSION }]
    expect(autoRespondsPermission(onFor(SESSION), sessions, { sessionID: "child", permission: "read" }, DIR)).toBe(true)
    expect(autoRespondsPermission(onFor(SESSION), sessions, { sessionID: "child", permission: "bash" }, DIR)).toBe(false)
  })

  // The control's checked state asks "is the switch on?", which must stay
  // independent of any one permission type.
  test("omitting the permission type reports switch state only", () => {
    expect(autoRespondsPermission(onFor(SESSION), [{ id: SESSION }], { sessionID: SESSION }, DIR)).toBe(true)
    expect(autoRespondsPermission({}, [{ id: SESSION }], { sessionID: SESSION }, DIR)).toBe(false)
  })

  test("reconciles only safe pending requests owned by auto sessions", () => {
    const sessions = [{ id: SESSION }, { id: "ses_other" }]
    const pending = [
      { id: "safe", sessionID: SESSION, permission: "read" },
      { id: "risky", sessionID: SESSION, permission: "bash" },
      { id: "other", sessionID: "ses_other", permission: "read" },
    ]

    expect(autoRespondablePermissions(onFor(SESSION), sessions, pending, DIR).map((item) => item.id)).toEqual(["safe"])
  })
})

describe("permission auto-response reconciliation", () => {
  test("keeps requests hidden only while automatic handling still owns them", () => {
    expect(autoResponseOwnsPermission({
      policyAutoResponds: true,
      reconciliation: "pending",
      responseFailed: false,
    })).toBe(true)
    expect(autoResponseOwnsPermission({
      policyAutoResponds: true,
      reconciliation: "ready",
      responseFailed: false,
    })).toBe(true)
    expect(autoResponseOwnsPermission({
      policyAutoResponds: true,
      reconciliation: "failed",
      responseFailed: false,
    })).toBe(false)
    expect(autoResponseOwnsPermission({
      policyAutoResponds: true,
      reconciliation: "ready",
      responseFailed: true,
    })).toBe(false)
  })

  test("renders requests after reconciliation settles, including failure", () => {
    expect(permissionRequestPolicyReady(false, "ready")).toBe(false)
    expect(permissionRequestPolicyReady(true, undefined)).toBe(false)
    expect(permissionRequestPolicyReady(true, "pending")).toBe(false)
    expect(permissionRequestPolicyReady(true, "ready")).toBe(true)
    expect(permissionRequestPolicyReady(true, "failed")).toBe(true)
  })

  test("reconciles a hydrated list through the real async orchestration", async () => {
    const responses: string[] = []
    const state = await reconcileAutoPermissionRequests({
      directory: DIR,
      active: () => true,
      autoAccept: onForDirectory,
      sessions: () => [{ id: SESSION }],
      list: async () => [
        { id: "safe", sessionID: SESSION, permission: "read" },
        { id: "risky", sessionID: SESSION, permission: "execute" },
      ],
      respond: (permission) => responses.push(permission.id),
    })

    expect(state).toBe("ready")
    expect(responses).toEqual(["safe"])
  })

  test("a list resolved after navigation cannot answer stale permissions", async () => {
    let active = true
    let release: ((value: Array<{ id: string; sessionID: string; permission: string }>) => void) | undefined
    const pending = new Promise<Array<{ id: string; sessionID: string; permission: string }>>((resolve) => {
      release = resolve
    })
    const responses: string[] = []
    const reconciliation = reconcileAutoPermissionRequests({
      directory: DIR,
      active: () => active,
      autoAccept: onForDirectory,
      sessions: () => [{ id: SESSION }],
      list: () => pending,
      respond: (permission) => responses.push(permission.id),
    })

    active = false
    release?.([{ id: "safe", sessionID: SESSION, permission: "read" }])

    await expect(reconciliation).resolves.toBe("ready")
    expect(responses).toEqual([])
  })

  test("a current list failure settles failed so the manual dock can recover", async () => {
    await expect(reconcileAutoPermissionRequests({
      directory: DIR,
      active: () => true,
      autoAccept: onForDirectory,
      sessions: () => [{ id: SESSION }],
      list: async () => { throw new Error("offline") },
      respond: () => undefined,
    })).resolves.toBe("failed")
  })
})
