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
    expect(shellPreloadPaths()).toEqual(SIGNED_READS)
  })

  test("no preload mints a workspace connection: a tab that holds a link never reads one, and the edge cannot tell", () => {
    expect(shellPreloadPaths().filter((path) => /^\/api\/workspace\/[^/]+\/connection/.test(path))).toEqual([])
  })

  test("the Link header preloads each read as a credentialed fetch", () => {
    expect(shellPreloadLinks()).toBe(SIGNED_READS.map((path) => `<${path}>; rel=preload; as=fetch; crossorigin=use-credentials`).join(", "))
  })
})
