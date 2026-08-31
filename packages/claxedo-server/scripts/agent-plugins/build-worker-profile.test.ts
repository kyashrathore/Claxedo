import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { buildAgentPluginsWorkerProfile } from "./build-worker-profile"

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))))

describe("Agent Plugins Worker deployment profile", () => {
  test("changes the static entry and adds feature-owned production and staging R2 bindings", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-plugins-worker-profile-"))
    roots.push(root)
    const output = buildAgentPluginsWorkerProfile({
      output: path.join(root, "wrangler.toml"),
      env: {
        CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_URL: "https://mcp.example.com",
        CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_ZONE_NAME: "example.com",
        CLAXEDO_CREDENTIALS_KV_NAMESPACE_ID: "prod-kv-id",
        CLAXEDO_PUBLIC_URL: "https://control.example.com",
      },
    })
    const profile = await fs.readFile(output, "utf8")
    const main = /^main = "([^"]+)"$/m.exec(profile)?.[1]
    expect(main).toBeTruthy()
    expect(path.resolve(path.dirname(output), main!)).toBe(path.resolve(
      import.meta.dirname,
      "../../src/deployments/hosted-workerd/worker.agent-plugins.ts",
    ))
    expect(profile.match(/binding = "CLAXEDO_AGENT_PLUGINS"/g)).toHaveLength(2)
    expect(profile).toContain('bucket_name = "claxedo-agent-plugins"')
    expect(profile).toContain('bucket_name = "claxedo-agent-plugins-staging"')
    expect(profile).toContain('CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_URL = "https://mcp.example.com/"')
    expect(profile).toContain('pattern = "https://*.example.com/api/claxedo/plugins/mcp/*"')
    expect(profile).toContain('zone_name = "example.com"')
    expect(profile).toContain('CLAXEDO_HOSTED_CREDENTIALS_ENABLED = "1"')
    expect(profile).toContain('binding = "CLAXEDO_CREDENTIALS"')
    expect(profile).toContain('id = "prod-kv-id"')
    expect(profile).toContain('CLAXEDO_PUBLIC_URL = "https://control.example.com/"')
    expect(profile).toContain("[[kv_namespaces]]")
    expect(profile).toContain("[[routes]]")
    expect(profile).toContain("workers_dev = true")
  })

  test("uses an isolated staging origin and staging route", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-plugins-worker-profile-"))
    roots.push(root)
    const output = buildAgentPluginsWorkerProfile({
      output: path.join(root, "wrangler.toml"),
      staging: true,
      env: {
        CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_URL_STAGING: "https://mcp-staging.example.com",
        CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_ZONE_NAME: "example.com",
        CLAXEDO_CREDENTIALS_KV_NAMESPACE_ID_STAGING: "staging-kv-id",
        CLAXEDO_PUBLIC_URL_STAGING: "https://control-staging.example.com",
      },
    })
    const profile = await fs.readFile(output, "utf8")

    expect(profile).toContain('CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_URL = "https://mcp-staging.example.com/"')
    expect(profile).toContain("[[env.staging.routes]]")
    expect(profile).toContain('pattern = "https://*.example.com/api/claxedo/plugins/mcp/*"')
    expect(profile).toContain("[[env.staging.kv_namespaces]]")
    expect(profile).toContain('id = "staging-kv-id"')
    expect(profile).toContain('CLAXEDO_PUBLIC_URL = "https://control-staging.example.com/"')
  })

  test("fails before deployment when the gateway route cannot be made safe", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-plugins-worker-profile-"))
    roots.push(root)

    expect(() => buildAgentPluginsWorkerProfile({
      output: path.join(root, "wrangler.toml"),
      env: {
        CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_URL: "http://localhost:3000/gateway",
        CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_ZONE_NAME: "example.com",
        CLAXEDO_CREDENTIALS_KV_NAMESPACE_ID: "prod-kv-id",
        CLAXEDO_PUBLIC_URL: "https://control.example.com",
      },
    })).toThrow(/must be an HTTPS origin/)
  })

  test("rejects a deep gateway base that would require non-standard TLS coverage", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-plugins-worker-profile-"))
    roots.push(root)

    expect(() => buildAgentPluginsWorkerProfile({
      output: path.join(root, "wrangler.toml"),
      staging: true,
      env: {
        CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_URL_STAGING: "https://mcp.staging.example.com",
        CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_ZONE_NAME: "example.com",
        CLAXEDO_CREDENTIALS_KV_NAMESPACE_ID_STAGING: "staging-kv-id",
        CLAXEDO_PUBLIC_URL_STAGING: "https://control-staging.example.com",
      },
    })).toThrow(/exactly one label below/)
  })

  test("rejects a control-plane URL with a path because OAuth routes are origin-relative", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-plugins-worker-profile-"))
    roots.push(root)

    expect(() => buildAgentPluginsWorkerProfile({
      output: path.join(root, "wrangler.toml"),
      env: {
        CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_URL: "https://mcp.example.com",
        CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_ZONE_NAME: "example.com",
        CLAXEDO_CREDENTIALS_KV_NAMESPACE_ID: "prod-kv-id",
        CLAXEDO_PUBLIC_URL: "https://control.example.com/base",
      },
    })).toThrow(/public HTTPS origin/)
  })
})
