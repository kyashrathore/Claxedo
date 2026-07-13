import { describe, expect, test } from "bun:test"
import { githubIntegration } from "./github.js"
import { atlassianIntegration } from "./atlassian.js"
import { linearIntegration } from "./linear.js"

describe("first-party work-source integrations", () => {
  test("declare only their applicable capabilities", () => {
    expect(githubIntegration().decl.capabilities).toEqual(["code-host", "work-source"])
    expect(atlassianIntegration().decl.capabilities).toEqual(["docs", "work-source"])
    expect(linearIntegration().decl.capabilities).toEqual(["work-source"])
  })

  test("verifies Linear without retaining or returning its key", async () => {
    const seen: string[] = []
    const integration = linearIntegration({
      fetchImpl: (async (_url, init) => {
        seen.push(String((init?.headers as Record<string, string>).authorization))
        return Response.json({ data: { viewer: { name: "Alice" } } })
      }) as typeof fetch,
    })
    expect(await integration.impl.verify!({}, "linear-secret")).toEqual({ ok: true, accountLabel: "Alice" })
    expect(seen).toEqual(["Bearer linear-secret"])
    expect(JSON.stringify(integration.decl)).not.toContain("linear-secret")
  })
})
