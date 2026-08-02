import { describe, expect, test } from "bun:test"
import { appProjectWorkGraphKey } from "./project-key"

describe("appProjectWorkGraphKey", () => {
  test("matches the canonical local Stream project key", () => {
    expect(appProjectWorkGraphKey({ worktree: "/repo/main" })).toBe("local:/repo/main")
  })

  test("uses the hosted repository identity for a cloud workspace", () => {
    expect(
      appProjectWorkGraphKey(
        {
          worktree: "/repo/main",
          workspaces: {
            "workspace:cloud": {
              id: "workspace:cloud",
              kind: "cloud",
              repo_url: "https://example.com/acme/repo.git",
            },
          },
        },
        "workspace:cloud",
      ),
    ).toBe("hosted:https://example.com/acme/repo.git")
  })
})
