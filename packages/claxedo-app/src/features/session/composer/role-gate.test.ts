import { describe, expect, test } from "bun:test"
import type { Placement, RelayRole } from "@/platform/runtime/placement"
import { promptDesignPlaceholder, submitAuthorityBlock, submitBlockedByRole } from "./role-gate"

const placement = (role?: RelayRole): Placement => ({
  workspaceId: "ws_1",
  hosting: "workspace",
  transport: "workspace-relay",
  ...(role ? { role } : {}),
})

describe("submitBlockedByRole", () => {
  test("blocks viewer and role-less placements", () => {
    expect(submitBlockedByRole(placement("viewer"))).toBe(true)
    expect(submitBlockedByRole(placement())).toBe(true)
  })

  test("allows editor, admin, owner, and unknown authority", () => {
    expect(submitBlockedByRole(placement("editor"))).toBe(false)
    expect(submitBlockedByRole(placement("admin"))).toBe(false)
    expect(submitBlockedByRole(placement("owner"))).toBe(false)
    expect(submitBlockedByRole(undefined)).toBe(false)
  })
})

describe("submitAuthorityBlock", () => {
  test("a send grantee sends although the workspace ranks them viewer", () => {
    expect(submitAuthorityBlock({ sessionPromptAdmitted: true, workspacePlacement: placement("viewer") }))
      .toBeUndefined()
  })

  test("a follow grantee is refused by the session, not by the workspace", () => {
    expect(submitAuthorityBlock({ sessionPromptAdmitted: false, workspacePlacement: placement("owner") }))
      .toBe("session-share")
  })

  test("a draft names no session, so the workspace answers", () => {
    expect(submitAuthorityBlock({ sessionPromptAdmitted: undefined, workspacePlacement: placement("viewer") }))
      .toBe("workspace-role")
    expect(submitAuthorityBlock({ sessionPromptAdmitted: undefined, workspacePlacement: placement("editor") }))
      .toBeUndefined()
  })
})

describe("promptDesignPlaceholder", () => {
  test("names the authority that refused, and otherwise leaves the mode's placeholder alone", () => {
    const rest = { mode: "shell" as const, shellPlaceholder: "Run a command" }
    expect(promptDesignPlaceholder({ authorityBlock: "session-share", ...rest }))
      .toBe("You can follow this session, not send to it")
    expect(promptDesignPlaceholder({ authorityBlock: "workspace-role", ...rest }))
      .toBe("Read-only workspace (viewer)")
    expect(promptDesignPlaceholder({ authorityBlock: undefined, ...rest })).toBe("Run a command")
  })
})
