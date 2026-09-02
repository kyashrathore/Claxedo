import { afterAll, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import { execFileSync } from "node:child_process"
import os from "node:os"
import path from "node:path"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-config-harness-routes-"))
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { agentConfigHarnessRoutes } = await import("./harness-routes")
const { agentConfigAcpConnectionRoutes } = await import("./acp-connection-routes")
const { defaultHarness, loadUserConfig } = await import("@claxedo/server-core/agent-config/index")
const { ensureWorkspace } = await import("@claxedo/server-core/workspace/store/index")

afterAll(async () => {
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  await fs.rm(root, { recursive: true, force: true })
})

async function workspaceDirectory(name: string) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(root, `${name}-`)))
  execFileSync("git", ["init", "-b", "main"], { cwd: directory, stdio: "ignore" })
  await ensureWorkspace({ directory })
  return directory
}

function setHarness(type: string) {
  return agentConfigHarnessRoutes().request("http://localhost/harness", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type }),
  })
}

function registerAcpConnection(id: string, body: unknown) {
  return agentConfigAcpConnectionRoutes().request(`http://localhost/harness/acp-connections/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

/**
 * An `acp:<id>` harness is a REFERENCE into the operator's accepted ACP
 * connection registry — the registry, not the request, owns the command. The
 * workspace runtime therefore refuses any ACP identity it holds no applied
 * descriptor for, so accepting one here would persist a default that nothing
 * downstream can run.
 */
describe("local harness config routes reject ACP identities no connection defines", () => {
  test("selecting an unregistered ACP connection is refused and leaves the default harness alone", async () => {
    const before = defaultHarness(await loadUserConfig())

    const response = await setHarness("acp:stranger")

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: {
        code: "agent_config_acp_connection_unavailable",
        message: 'ACP connection "stranger" is not configured. Add it under ACP connections before selecting it.',
      },
    })
    expect(defaultHarness(await loadUserConfig())).toEqual(before)
  })

  test("a registered connection is selectable, and disabling it makes the same identity unusable again", async () => {
    expect((await registerAcpConnection("openclaw", { label: "Openclaw", command: ["openclaw", "--acp"] })).status)
      .toBe(200)

    const accepted = await setHarness("acp:openclaw")
    expect(accepted.status).toBe(200)
    expect(defaultHarness(await loadUserConfig())).toMatchObject({ id: "openclaw", access: "acp" })

    expect(
      (await registerAcpConnection("openclaw", {
        label: "Openclaw",
        command: ["openclaw", "--acp"],
        enabled: false,
      })).status,
    ).toBe(200)

    const refused = await setHarness("acp:openclaw")
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({
      error: {
        code: "agent_config_acp_connection_unavailable",
        message: 'ACP connection "openclaw" is disabled. Enable it under ACP connections before selecting it.',
      },
    })
  })

  test("harness config options names the missing connection instead of reporting a transport failure", async () => {
    const directory = await workspaceDirectory("options")

    const response = await agentConfigHarnessRoutes().request(
      `http://localhost/harness/options?directory=${encodeURIComponent(directory)}&type=acp:stranger`,
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: {
        code: "agent_config_acp_connection_unavailable",
        message: 'ACP connection "stranger" is not configured. Add it under ACP connections before selecting it.',
      },
    })
  })
})
