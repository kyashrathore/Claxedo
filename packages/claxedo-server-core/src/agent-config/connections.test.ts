import { describe, expect, test } from "vitest"
import {
  createHarnessConnectionSchema,
  explicitDefaultHarness,
} from "./connections"

function connection(overrides: Record<string, unknown> = {}) {
  return {
    connectionId: "conn-primary",
    providerKey: "acp",
    configRevision: 1,
    enabled: true,
    config: {
      label: "Primary agent",
      connection: {
        kind: "process",
        command: "agent",
        args: ["--acp"],
        env: { AGENT_TOKEN: "trusted-config-secret" },
      },
      modelSelection: { status: "optional" },
    },
    secretRefs: { token: "credentials/agent-token" },
    ...overrides,
  }
}

describe("v3 harness connections", () => {
  const schema = createHarnessConnectionSchema()

  test("delegates provider config validation to the installed canonical provider", () => {
    const result = schema.validate({ "conn-primary": connection() })

    expect(result.problems).toEqual([])
    expect(result.accepted["conn-primary"]).toEqual(connection())
  })

  test("fails closed on legacy ACP rows, mismatched identity, unknown fields, and uninstalled providers", () => {
    const result = schema.validate({
      legacy: { label: "Legacy", command: ["agent", "--acp"] },
      mismatch: connection({ connectionId: "other" }),
      extra: connection({ connectionId: "extra", access: "acp" }),
      unknown: connection({ connectionId: "unknown", providerKey: "fixture" }),
    })

    expect(result.accepted).toEqual({})
    expect(result.problems.map((problem) => problem.connectionId)).toEqual([
      "legacy",
      "mismatch",
      "extra",
      "unknown",
    ])
  })

  test("uses the provider projection and redacts trusted descriptor fields", () => {
    const trusted = schema.validate({ "conn-primary": connection() }).accepted
    const publicRows = schema.publicRows(trusted)

    expect(publicRows).toEqual([{
      connectionId: "conn-primary",
      label: "Primary agent",
      enabled: true,
      readiness: "configured",
      capabilities: {
        abort: true,
        reconnect: false,
        replay: true,
        permissions: true,
        questions: true,
        todos: false,
        commands: false,
        fork: false,
        revert: false,
        unrevert: false,
        configOptions: true,
        subagents: false,
      },
      modelSelection: { status: "optional" },
    }])
    const serialized = JSON.stringify(publicRows)
    expect(serialized).not.toContain("providerKey")
    expect(serialized).not.toContain("configRevision")
    expect(serialized).not.toContain("credentials/agent-token")
    expect(serialized).not.toContain("trusted-config-secret")
    expect(serialized).not.toContain("--acp")
  })

  test("leaves selection unresolved unless a default is explicit", () => {
    expect(explicitDefaultHarness({})).toBeUndefined()
    expect(explicitDefaultHarness({ defaultConnectionId: "conn-primary" })).toEqual({
      kind: "connection",
      connectionId: "conn-primary",
    })
    expect(explicitDefaultHarness({ defaultHarness: { kind: "native", harnessId: "claude" } })).toEqual({
      kind: "native",
      harnessId: "claude",
    })
  })

  test("requires revision advancement and immutable provider identity for changed descriptors", () => {
    const previous = schema.validate({ "conn-primary": connection() }).accepted
    const unchanged = schema.validate({ "conn-primary": connection() }).accepted
    expect(schema.revisionProblems(previous, unchanged)).toEqual([])

    const changedWithoutRevision = schema.validate({
      "conn-primary": connection({
        config: {
          ...connection().config,
          label: "Renamed",
        },
      }),
    }).accepted
    expect(schema.revisionProblems(previous, changedWithoutRevision)).toEqual([{
      connectionId: "conn-primary",
      problem: "changed connection config requires a higher configRevision",
    }])

    const retargeted = {
      ...previous,
      "conn-primary": { ...previous["conn-primary"], providerKey: "fixture", configRevision: 2 },
    }
    expect(schema.revisionProblems(previous, retargeted)).toEqual([{
      connectionId: "conn-primary",
      problem: "connectionId and providerKey are immutable",
    }])
  })
})
