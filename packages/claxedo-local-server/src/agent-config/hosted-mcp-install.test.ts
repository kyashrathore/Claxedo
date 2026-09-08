import { afterEach, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  HostedMcpUrlError,
  hostedMcpUrl,
  installHostedMcpEntry,
  removeHostedMcpEntry,
} from "./hosted-mcp-install"

const homes: string[] = []

async function machine() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-mcp-install-"))
  homes.push(home)
  return {
    paths: { home },
    env: {} as NodeJS.ProcessEnv,
    read: (file: string) => fs.readFile(path.join(home, file), "utf8"),
    write: async (file: string, contents: string) => {
      await fs.mkdir(path.dirname(path.join(home, file)), { recursive: true })
      await fs.writeFile(path.join(home, file), contents)
    },
  }
}

afterEach(async () => {
  for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true })
})

describe("the URL a harness on this machine is told to reach", () => {
  test("is the hosted MCP endpoint", () => {
    expect(hostedMcpUrl("https://api.claxedo.com")).toBe("https://api.claxedo.com/api/claxedo/mcp")
    expect(hostedMcpUrl("https://api.claxedo.com/")).toBe("https://api.claxedo.com/api/claxedo/mcp")
  })

  test("is never this machine's loopback endpoint", () => {
    // The loopback mount admits only the credential the runtime injects into a
    // session it launched, so an entry naming it 401s everywhere a user would
    // copy it to.
    for (const origin of ["https://localhost:2593", "https://127.0.0.1:2593", "https://[::1]:2593", "https://app.localhost"]) {
      expect(() => hostedMcpUrl(origin)).toThrow(HostedMcpUrlError)
    }
    expect(() => hostedMcpUrl("http://api.claxedo.com")).toThrow(/https/)
    expect(() => hostedMcpUrl("not a url")).toThrow(HostedMcpUrlError)
  })
})

describe("installing the hosted entry", () => {
  test("refuses an existing unmanaged Codex entry without corrupting its TOML", async () => {
    const box = await machine()
    const original = '[mcp_servers."claxedo"]\nurl = "https://previous.example/mcp"\n'
    await box.write(".codex/config.toml", original)
    await expect(installHostedMcpEntry({ controlPlaneUrl: "https://api.claxedo.com", ...box })).rejects.toThrow(/outside the managed block/)
    expect(await box.read(".codex/config.toml")).toBe(original)
    await expect(box.read(".claude.json")).rejects.toMatchObject({ code: "ENOENT" })
    await expect(box.read(".cursor/mcp.json")).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("preserves restrictive permissions when replacing harness configuration", async () => {
    const box = await machine()
    await box.write(".claude.json", '{}\n')
    const file = path.join(box.paths.home, ".claude.json")
    await fs.chmod(file, 0o600)
    await installHostedMcpEntry({ controlPlaneUrl: "https://api.claxedo.com", ...box })
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  })

  test("writes one http entry into Claude Code, Cursor and Codex", async () => {
    const box = await machine()

    const outcome = await installHostedMcpEntry({ controlPlaneUrl: "https://api.claxedo.com", ...box })

    expect(outcome.url).toBe("https://api.claxedo.com/api/claxedo/mcp")
    expect(outcome.results.map((result) => result.state)).toEqual(["written", "written", "written"])
    expect(JSON.parse(await box.read(".claude.json")).mcpServers).toEqual({
      claxedo: { type: "http", url: "https://api.claxedo.com/api/claxedo/mcp" },
    })
    expect(JSON.parse(await box.read(".cursor/mcp.json")).mcpServers).toEqual({
      claxedo: { type: "http", url: "https://api.claxedo.com/api/claxedo/mcp" },
    })
    expect(await box.read(".codex/config.toml")).toContain('[mcp_servers.claxedo]\nurl = "https://api.claxedo.com/api/claxedo/mcp"')
  })

  test("keeps every server and setting the user already had", async () => {
    const box = await machine()
    await box.write(".claude.json", JSON.stringify({
      numStartups: 12,
      mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } },
    }))
    await box.write(".codex/config.toml", 'model = "gpt-5"\n\n[mcp_servers.linear]\nurl = "https://mcp.linear.app/mcp"\n')

    await installHostedMcpEntry({ controlPlaneUrl: "https://api.claxedo.com", ...box })

    const claude = JSON.parse(await box.read(".claude.json"))
    expect(claude.numStartups).toBe(12)
    expect(Object.keys(claude.mcpServers)).toEqual(["linear", "claxedo"])
    const codex = await box.read(".codex/config.toml")
    expect(codex).toContain('model = "gpt-5"')
    expect(codex).toContain("[mcp_servers.linear]")
    expect(codex).toContain("[mcp_servers.claxedo]")
  })

  test("installing twice changes nothing the second time", async () => {
    const box = await machine()
    await installHostedMcpEntry({ controlPlaneUrl: "https://api.claxedo.com", ...box })

    const again = await installHostedMcpEntry({ controlPlaneUrl: "https://api.claxedo.com", ...box })

    expect(again.results.map((result) => result.state)).toEqual(["unchanged", "unchanged", "unchanged"])
  })

  test("moving to another control plane replaces the entry rather than adding one", async () => {
    const box = await machine()
    await installHostedMcpEntry({ controlPlaneUrl: "https://api.claxedo.com", ...box })

    await installHostedMcpEntry({ controlPlaneUrl: "https://claxedo.example.com", ...box })

    expect(JSON.parse(await box.read(".claude.json")).mcpServers).toEqual({
      claxedo: { type: "http", url: "https://claxedo.example.com/api/claxedo/mcp" },
    })
    const codex = await box.read(".codex/config.toml")
    expect(codex.match(/\[mcp_servers\.claxedo\]/g)).toHaveLength(1)
    expect(codex).toContain("https://claxedo.example.com/api/claxedo/mcp")
  })

  test("refuses to touch a config file the harness itself cannot read", async () => {
    const box = await machine()
    await box.write(".claude.json", "{ this is not json")

    await expect(installHostedMcpEntry({ controlPlaneUrl: "https://api.claxedo.com", ...box })).rejects.toThrow()
    expect(await box.read(".claude.json")).toBe("{ this is not json")
  })
})

describe("removing the hosted entry", () => {
  test("takes back only what it wrote", async () => {
    const box = await machine()
    await box.write(".claude.json", JSON.stringify({
      mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } },
    }))
    await box.write(".codex/config.toml", 'model = "gpt-5"\n')
    await installHostedMcpEntry({ controlPlaneUrl: "https://api.claxedo.com", ...box })

    const outcome = await removeHostedMcpEntry(box)

    expect(outcome.results.map((result) => result.state)).toEqual(["removed", "removed", "removed"])
    expect(JSON.parse(await box.read(".claude.json")).mcpServers).toEqual({
      linear: { type: "http", url: "https://mcp.linear.app/mcp" },
    })
    expect(await box.read(".codex/config.toml")).toBe('model = "gpt-5"\n')
  })

  test("creates no config for a harness this machine does not have", async () => {
    const box = await machine()

    const outcome = await removeHostedMcpEntry(box)

    expect(outcome.results.map((result) => result.state)).toEqual(["unchanged", "unchanged", "unchanged"])
    await expect(box.read(".claude.json")).rejects.toThrow()
  })
})
