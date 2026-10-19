import { describe, expect, test } from "vitest"
import { shellPreloadLinks, shellPreloadPaths } from "./shell-preloads"

const SIGNED_READS = [
  "/api/auth/get-session",
  "/api/workspace/shared-sessions",
  "/api/workspace?host=provisioner",
  "/api/claxedo/remote-access/devices",
  "/api/claxedo/agent-config/connections",
  "/api/control/session-list?scope=projects&limit=5&sort=human_turn_desc&settled=active",
]

describe("the shell's preloads", () => {
  test("every signed route reads the session, the rail's catalog and its first session page", () => {
    for (const pathname of ["/", "/login", "/settings", "/s/ses_1", "/nowhere/in/particular"]) expect(shellPreloadPaths(pathname)).toEqual(SIGNED_READS)
  })

  test("a workspace route also reads that workspace's connection, encoded as the app encodes it", () => {
    expect(shellPreloadPaths("/w/ws_1/session/ses_1")).toEqual([...SIGNED_READS, "/api/workspace/ws_1/connection"])
    expect(shellPreloadPaths("/w/ws_1/session")).toEqual([...SIGNED_READS, "/api/workspace/ws_1/connection"])
    expect(shellPreloadPaths("/w/ws_1")).toEqual([...SIGNED_READS, "/api/workspace/ws_1/connection"])
    expect(shellPreloadPaths("/w/ws%3A1/terminal/t_1")).toEqual([...SIGNED_READS, "/api/workspace/ws%3A1/connection"])
    expect(shellPreloadPaths("/w/")).toEqual(SIGNED_READS)
    expect(shellPreloadPaths("/wide/open")).toEqual(SIGNED_READS)
  })

  test("the Link header preloads each read as a credentialed fetch", () => {
    expect(shellPreloadLinks("/w/ws_1/session/ses_1")).toBe(
      [...SIGNED_READS, "/api/workspace/ws_1/connection"].map((path) => `<${path}>; rel=preload; as=fetch; crossorigin=use-credentials`).join(", "),
    )
  })
})
