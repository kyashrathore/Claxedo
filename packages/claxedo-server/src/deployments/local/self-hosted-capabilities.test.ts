import { describe, expect, test } from "vitest"
import { noSelfHostedCapabilities, selfHostedCapabilities } from "./self-hosted-capabilities"

/**
 * The capability seam that separates the two products sharing this composition
 * root: the desktop sidecar contributes nothing, the self-hosted single binary
 * contributes WorkGraph.
 */
describe("self-hosted capabilities", () => {
  test("contributes both WorkGraph route groups", () => {
    const capabilities = selfHostedCapabilities({
      workGraphRunBroker: async () => {
        throw new Error("unused")
      },
    })

    expect(capabilities.runtimeRouteContributions.map((contribution) => contribution.id)).toEqual([
      "workgraph.connection-tools",
      "workgraph.run-tools",
    ])
  })

  test("the desktop-local composition contributes nothing", () => {
    expect(noSelfHostedCapabilities().runtimeRouteContributions).toEqual([])
  })

  test("each contribution owns a distinct session-tool group", () => {
    // Two contributions sharing a group name would make the second silently
    // replace the first's tools for a session — the failure the runtime's
    // group merging exists to prevent, reintroduced one layer up.
    const groups: string[] = []
    const capabilities = selfHostedCapabilities({
      workGraphRunBroker: async () => {
        throw new Error("unused")
      },
    })

    for (const contribution of capabilities.runtimeRouteContributions) {
      const mount = contribution.mount({
        workspaceId: "ws_1",
        registerSessionTools: (group) => {
          groups.push(group)
          return async () => {}
        },
        unregisterSessionTools: () => async () => {},
      })
      mount.dispose()
    }

    expect(groups).toEqual(["connections", "run"])
    expect(groups).toEqual([...new Set(groups)])
  })
})
