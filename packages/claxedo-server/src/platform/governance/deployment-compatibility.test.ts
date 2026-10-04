import { describe, expect, test } from "vitest"
import { deploymentCompatibilityReport } from "./deployment-compatibility"

describe("deployment compatibility report", () => {
  test("reports the central tunnel protocol and package compatibility metadata", () => {
    expect(deploymentCompatibilityReport({
      CLAXEDO_CENTRAL_VERSION: "central-1",
      CLAXEDO_EXPECTED_CENTRAL_VERSION: "central-1",
      CLAXEDO_APP_VERSION: "app-1",
      CLAXEDO_EXPECTED_APP_VERSION: "app-1",
      CLAXEDO_CLI_VERSION: "cli-1",
      CLAXEDO_EXPECTED_CLI_VERSION: "cli-1",
      CLAXEDO_RELAY_VERSION: "relay-1",
      CLAXEDO_EXPECTED_RELAY_VERSION: "relay-1",
      CLAXEDO_RUNTIME_VERSION: "runtime-1",
      CLAXEDO_EXPECTED_RUNTIME_VERSION: "runtime-1",
      CLAXEDO_RELAY_PROTOCOL_VERSION: "0.1.0",
      CLAXEDO_EXPECTED_RELAY_PROTOCOL_VERSION: "0.1.0",
    })).toMatchObject({
      ok: true,
      schemaVersion: 1,
      connectionSchemaVersion: 1,
      tunnelProtocolVersion: 1,
      runtimeAccessTokenAudience: "workspace-relay",
      hostTunnelTokenAudience: "workspace-relay-host-tunnel",
      components: {
        central: { version: "central-1", expectedVersion: "central-1" },
        app: { version: "app-1", expectedVersion: "app-1" },
        cli: { version: "cli-1", expectedVersion: "cli-1" },
        relay: { version: "relay-1", expectedVersion: "relay-1" },
        runtime: { version: "runtime-1", expectedVersion: "runtime-1" },
        relayProtocol: { version: "0.1.0", expectedVersion: "0.1.0", packageVersion: "0.1.0" },
      },
    })
  })

  test("marks incompatible expected tunnel protocol versions as not ok", () => {
    expect(deploymentCompatibilityReport({
      CLAXEDO_EXPECTED_TUNNEL_PROTOCOL_VERSION: "2",
    })).toMatchObject({
      ok: false,
      expectedTunnelProtocolVersion: 2,
      checks: expect.arrayContaining([{
        name: "tunnel_protocol",
        ok: false,
        message: "central=1 expected=2",
      }]),
    })
  })

  test("marks mismatched rollout component version pins as not ok", () => {
    expect(deploymentCompatibilityReport({
      CLAXEDO_APP_VERSION: "app-1",
      CLAXEDO_EXPECTED_APP_VERSION: "app-2",
      CLAXEDO_EXPECTED_CLI_VERSION: "cli-1",
    })).toMatchObject({
      ok: false,
      components: {
        app: { version: "app-1", expectedVersion: "app-2" },
        cli: { expectedVersion: "cli-1" },
      },
      checks: expect.arrayContaining([
        {
          name: "version_app",
          ok: false,
          message: "app=app-1 expected=app-2",
        },
        {
          name: "version_cli",
          ok: false,
          message: "cli=missing expected=cli-1",
        },
      ]),
    })
  })
})
