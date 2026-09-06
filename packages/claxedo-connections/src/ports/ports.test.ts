import { describe, expect, test } from "bun:test"
import {
  CAPABILITIES,
  capabilitiesOf,
  channelPort,
  docsPort,
  mcpPort,
  workSourcePort,
  type CapabilityPorts,
  type CodeHostPort,
} from "./index.js"

const codeHostPort: CodeHostPort = {
  capability: "code-host",
  listRepositories: async () => [],
}

describe("capability ports", () => {
  test("a capability name exists only where a port serves it", () => {
    // CAPABILITIES is checked against `keyof CapabilityPorts` at compile time by
    // CAPABILITIES_ARE_EXHAUSTIVE; this pins the other direction, that nothing
    // in the list is a name the port map does not have.
    const ports: CapabilityPorts = {
      "code-host": codeHostPort,
      docs: docsPort,
      "work-source": workSourcePort,
      channel: channelPort,
      mcp: mcpPort,
    }
    expect([...CAPABILITIES].sort()).toEqual(Object.keys(ports).sort() as (keyof CapabilityPorts)[])
  })

  test("derives exactly the capabilities whose ports are present", () => {
    expect(capabilitiesOf({})).toEqual([])
    expect(capabilitiesOf({ docs: docsPort })).toEqual(["docs"])
    expect(capabilitiesOf({ "code-host": codeHostPort, mcp: mcpPort })).toEqual(["code-host", "mcp"])
  })

  test("derivation order follows CAPABILITIES, not the order the impl was written in", () => {
    expect(capabilitiesOf({ mcp: mcpPort, "code-host": codeHostPort })).toEqual(["code-host", "mcp"])
  })

  test("refuses a port whose own capability disagrees with the key it is filed under", () => {
    expect(() => capabilitiesOf({ channel: docsPort as unknown as typeof channelPort })).toThrow(
      "integration port filed under channel declares docs",
    )
  })

  test("an entry present but not a port is refused rather than counted", () => {
    expect(() => capabilitiesOf({ docs: {} as typeof docsPort })).toThrow(
      "integration port filed under docs declares undefined",
    )
  })
})

describe("capability ports reject bad shapes at compile time", () => {
  test("the negative assertions above compile only because they are errors", () => {
    // @ts-expect-error a port map entry must implement the port it names:
    // `code-host` is action-served, so the marker alone is not enough.
    const missingMethod: Partial<CapabilityPorts> = { "code-host": { capability: "code-host" } }

    // @ts-expect-error ports are not interchangeable. The `capability`
    // discriminant is what makes a mislabelled grant a compile error instead of
    // a silent one.
    const mislabelled: Partial<CapabilityPorts> = { docs: workSourcePort }

    // @ts-expect-error a capability with no port behind it is not a capability.
    const invented: Partial<CapabilityPorts> = { "issue-tracker": docsPort }

    expect([missingMethod, mislabelled, invented]).toHaveLength(3)
  })
})
