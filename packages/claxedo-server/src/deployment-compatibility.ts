import { TUNNEL_PROTOCOL_VERSION } from "@claxedo/workspace-relay-protocol"

export const CLAXEDO_COMPATIBILITY_SCHEMA_VERSION = 1
export const CLAXEDO_CONNECTION_SCHEMA_VERSION = 1

export type DeploymentCompatibilityEnv = Record<string, string | undefined>

export type DeploymentCompatibilityReport = {
  ok: boolean
  schemaVersion: number
  connectionSchemaVersion: number
  tunnelProtocolVersion: number
  expectedTunnelProtocolVersion: number
  runtimeAccessTokenAudience: "workspace-relay"
  hostTunnelTokenAudience: "workspace-relay-host-tunnel"
  components: {
    central: ComponentCompatibility
    app: ComponentCompatibility
    cli: ComponentCompatibility
    relay: ComponentCompatibility
    runtime: ComponentCompatibility
    relayProtocol: ComponentCompatibility & { packageVersion: string }
  }
  checks: Array<{
    name: string
    ok: boolean
    message: string
  }>
}

type ComponentCompatibility = {
  version?: string
  expectedVersion?: string
}

function clean(input: string | undefined) {
  const value = input?.trim()
  return value ? value : undefined
}

function numberEnv(input: string | undefined, fallback: number) {
  const parsed = Number(clean(input))
  return Number.isFinite(parsed) ? parsed : fallback
}

function component(version: string | undefined, expectedVersion: string | undefined): ComponentCompatibility {
  return {
    ...(clean(version) ? { version: clean(version) } : {}),
    ...(clean(expectedVersion) ? { expectedVersion: clean(expectedVersion) } : {}),
  }
}

function versionCheck(name: string, version: string | undefined, expectedVersion: string | undefined) {
  const actual = clean(version)
  const expected = clean(expectedVersion)
  return {
    name: `version_${name}`,
    ok: !expected || actual === expected,
    message: expected
      ? `${name}=${actual ?? "missing"} expected=${expected}`
      : `${name}=${actual ?? "unconfigured"} expected=unconfigured`,
  }
}

export function deploymentCompatibilityReport(env: DeploymentCompatibilityEnv = process.env): DeploymentCompatibilityReport {
  const expectedTunnelProtocolVersion = numberEnv(env.CLAXEDO_EXPECTED_TUNNEL_PROTOCOL_VERSION, TUNNEL_PROTOCOL_VERSION)
  const centralVersion = clean(env.CLAXEDO_CENTRAL_VERSION) ?? "dev"
  const relayProtocolVersion = clean(env.CLAXEDO_RELAY_PROTOCOL_VERSION) ?? "0.1.0"
  const checks = [
    {
      name: "tunnel_protocol",
      ok: expectedTunnelProtocolVersion === TUNNEL_PROTOCOL_VERSION,
      message: `central=${TUNNEL_PROTOCOL_VERSION} expected=${expectedTunnelProtocolVersion}`,
    },
    versionCheck("central", centralVersion, env.CLAXEDO_EXPECTED_CENTRAL_VERSION),
    versionCheck("app", env.CLAXEDO_APP_VERSION, env.CLAXEDO_EXPECTED_APP_VERSION),
    versionCheck("cli", env.CLAXEDO_CLI_VERSION, env.CLAXEDO_EXPECTED_CLI_VERSION),
    versionCheck("relay", env.CLAXEDO_RELAY_VERSION, env.CLAXEDO_EXPECTED_RELAY_VERSION),
    versionCheck("runtime", env.CLAXEDO_RUNTIME_VERSION, env.CLAXEDO_EXPECTED_RUNTIME_VERSION),
    versionCheck("relay_protocol", relayProtocolVersion, env.CLAXEDO_EXPECTED_RELAY_PROTOCOL_VERSION),
  ]

  return {
    ok: checks.every((item) => item.ok),
    schemaVersion: CLAXEDO_COMPATIBILITY_SCHEMA_VERSION,
    connectionSchemaVersion: CLAXEDO_CONNECTION_SCHEMA_VERSION,
    tunnelProtocolVersion: TUNNEL_PROTOCOL_VERSION,
    expectedTunnelProtocolVersion,
    runtimeAccessTokenAudience: "workspace-relay",
    hostTunnelTokenAudience: "workspace-relay-host-tunnel",
    components: {
      central: component(centralVersion, env.CLAXEDO_EXPECTED_CENTRAL_VERSION),
      app: component(env.CLAXEDO_APP_VERSION, env.CLAXEDO_EXPECTED_APP_VERSION),
      cli: component(env.CLAXEDO_CLI_VERSION, env.CLAXEDO_EXPECTED_CLI_VERSION),
      relay: component(env.CLAXEDO_RELAY_VERSION, env.CLAXEDO_EXPECTED_RELAY_VERSION),
      runtime: component(env.CLAXEDO_RUNTIME_VERSION, env.CLAXEDO_EXPECTED_RUNTIME_VERSION),
      relayProtocol: {
        ...component(relayProtocolVersion, env.CLAXEDO_EXPECTED_RELAY_PROTOCOL_VERSION),
        packageVersion: relayProtocolVersion,
      },
    },
    checks,
  }
}
