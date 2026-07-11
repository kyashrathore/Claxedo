import { describe, expect, test } from "bun:test"
import {
  networkPolicyCreateBody,
  networkPolicyGroupsUrl,
  networkPolicyRowUrl,
  networkPolicyRowsUrl,
  parsePolicyEntries,
  parsePolicyGroups,
  policyEntryLabel,
  policyKindFromValue,
  shouldUseNetworkPolicyRows,
} from "./network-policy-settings-helpers"

describe("network policy settings", () => {
  test("loads policy rows for local control plane or explicit workspace scope", () => {
    expect(shouldUseNetworkPolicyRows({})).toBe(true)
    expect(shouldUseNetworkPolicyRows({ baseUrl: "http://127.0.0.1:3001" })).toBe(true)
    expect(shouldUseNetworkPolicyRows({ baseUrl: "https://claxedo.example.test" })).toBe(false)
    expect(shouldUseNetworkPolicyRows({ baseUrl: "https://claxedo.example.test", workspaceId: "ws_1" })).toBe(true)
    expect(shouldUseNetworkPolicyRows({ baseUrl: "https://claxedo.example.test", workspaceId: "   " })).toBe(false)
  })

  test("builds route URLs with encoded workspace context", () => {
    expect(networkPolicyRowsUrl("https://control.example", "ws 1")).toBe(
      "https://control.example/api/claxedo/network-policy?workspace_id=ws+1",
    )
    expect(networkPolicyRowsUrl("https://control.example")).toBe(
      "https://control.example/api/claxedo/network-policy",
    )
    expect(networkPolicyGroupsUrl("https://control.example")).toBe(
      "https://control.example/api/claxedo/network-policy/groups",
    )
    expect(networkPolicyRowUrl("https://control.example", "policy / one")).toBe(
      "https://control.example/api/claxedo/network-policy/policy%20%2F%20one",
    )
  })

  test("builds create bodies without unscoped workspace fields", () => {
    expect(networkPolicyCreateBody({ target: "api.example.com", kind: "host" })).toEqual({
      target: "api.example.com",
      kind: "host",
    })
    expect(networkPolicyCreateBody({ workspaceId: " ws_1 ", target: "api.example.com", kind: "host" })).toEqual({
      workspace_id: "ws_1",
      target: "api.example.com",
      kind: "host",
    })
  })

  test("parses policy rows defensively", () => {
    const rows = parsePolicyEntries({
      policies: [
        {
          id: "policy_1",
          target: "api.example.com",
          kind: "host",
          constraints: { auto: true, source: "mcp:github", ignored: "value" },
        },
        { id: "bad", target: "bad.example.com", kind: "other" },
      ],
    })

    expect(rows).toEqual([{
      id: "policy_1",
      target: "api.example.com",
      kind: "host",
      constraints: { auto: true, source: "mcp:github" },
    }])
    expect(policyEntryLabel(rows[0])).toBe("github")
  })

  test("parses groups and normalizes policy kind input", () => {
    expect(parsePolicyGroups({
      groups: {
        npm: ["registry.npmjs.org", 42],
        broken: "nope",
      },
    })).toEqual({ npm: ["registry.npmjs.org"] })
    expect(policyKindFromValue("domain")).toBe("domain")
    expect(policyKindFromValue("unexpected")).toBe("host")
  })
})
