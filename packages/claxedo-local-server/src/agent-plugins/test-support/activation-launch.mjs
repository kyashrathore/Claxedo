import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { inspectPluginDirectory } from "@claxedo/server-core/agent-plugins/artifacts/node-tree"
import { LocalAgentPluginArtifactStore } from "../artifacts/local-store"
import { codexAgentPluginAdapter } from "../runtime/adapters/codex"
import { cursorAgentPluginAdapter } from "../runtime/adapters/cursor"
import { openCodeAgentPluginAdapter } from "../runtime/adapters/opencode"
import { agentPluginHarnessLaunch, materializeAgentPluginGeneration, readMaterializedAgentPluginGeneration } from "../runtime/materialize"
import { prepareCodexProfile } from "../../../../harness/src/profiles/codex"
import { composeCursorHome } from "../../../../harness/src/profiles/cursor"
import { pluginProjectionFor, startInput } from "@claxedo/session-core"

const FIXTURE_HOME_PREFIX = "plugin-activation-fixture-"

async function assertFixtureHome(home) {
  const resolved = await fs.realpath(home)
  assert.equal(path.dirname(resolved), await fs.realpath(os.tmpdir()), `${home} is not a fixture home`)
  assert.ok(path.basename(resolved).startsWith(FIXTURE_HOME_PREFIX), `${home} is not a fixture home`)
  assert.equal(await fs.realpath(os.homedir()), resolved, "the fixture must run in a child whose HOME is its fixture home")
}

async function activationLaunchFixture(home, mode) {
  await assertFixtureHome(home)
  const selected = mode === "selected" || mode === "empty"
  const personalCodex = path.join(home, ".codex")
  const personalCursor = path.join(home, ".cursor")
  await fs.mkdir(personalCodex, { recursive: true })
  await fs.mkdir(path.join(personalCursor, "plugins/local/personal"), { recursive: true })
  await fs.writeFile(path.join(personalCodex, "config.toml"), 'model = "personal"\n')
  await fs.writeFile(path.join(personalCodex, "auth.json"), '{"fixture":true}\n')
  await fs.writeFile(path.join(personalCursor, "plugins/local/personal/plugin.json"), '{"name":"personal"}\n')
  async function snapshot(root) {
    const names = (await fs.readdir(root, { recursive: true })).sort()
    return Promise.all(names.map(async (name) => {
      const file = path.join(root, name)
      return [name, (await fs.stat(file)).isDirectory() ? "directory" : (await fs.readFile(file)).toString("base64")]
    }))
  }
  const before = [await snapshot(personalCodex), await snapshot(personalCursor)]
  const source = path.join(home, "source")
  await fs.mkdir(path.join(source, "skills/review"), { recursive: true })
  await fs.writeFile(path.join(source, "plugin.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "review" }))
  await fs.writeFile(path.join(source, "skills/review/SKILL.md"), "---\nname: review\ndescription: Review code\n---\nReview\n")
  // The stub server prints the directory it was started in.
  const server = process.platform === "win32" ? { name: "server.cmd", body: "@echo %CD%\r\n" } : { name: "server", body: '#!/bin/sh\nprintf "%s" "$PWD"\n' }
  await fs.writeFile(path.join(source, server.name), server.body, { mode: 0o755 })
  await fs.writeFile(path.join(source, "mcp.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: {
    docs: { type: "streamable-http", url: "https://plugin.example/mcp", headers: { Authorization: "fixture-plugin-token" } },
    local: { type: "stdio", command: `./${server.name}`, cwd: "./skills", args: ["${PLUGIN_DATA}/state"] },
  } }))
  const artifacts = new LocalAgentPluginArtifactStore(path.join(home, "artifacts"))
  const retained = await artifacts.put(await inspectPluginDirectory(source))
  const runtimeRoot = path.join(home, "runtime")
  const generation = await materializeAgentPluginGeneration({
    runtimeRoot, identity: { mode: "unsigned", machineId: "fixture" }, revision: 1, artifacts,
    execution: selected ? { mode: "selected", selectionHash: "selection-a" } : { mode: "default" },
    selections: mode === "empty" ? [] : [{ pluginInstanceId: "review-instance", artifactDigest: retained.digest, harnessIds: ["codex", "cursor", "opencode"], ...(selected ? { contribution: { kind: "plugin" } } : {}) }],
    adapters: [codexAgentPluginAdapter(), cursorAgentPluginAdapter(), openCodeAgentPluginAdapter()],
  })
  const restored = await readMaterializedAgentPluginGeneration(runtimeRoot)
  assert.deepEqual(agentPluginHarnessLaunch(restored), agentPluginHarnessLaunch(generation))
  const launch = {
    workspaceId: "fixture",
    projection: (harness) => pluginProjectionFor(harness, { generation: "snapshot:1", mcp: {}, harnessLaunch: agentPluginHarnessLaunch(restored) }),
    credentials: () => ({ placement: "loopback", machineOwnerUserId: "fixture", canUseOwnLogin: true, accounts: {}, leaseGeneration: "fixture" }),
  }
  const owner = { kind: "person", userId: "fixture" }
  function session(id) {
    return startInput(launch, { sessionId: id, directory: home, locality: "local", owner, config: { harness: { id, access: "native" } } })
  }
  if (mode === "opencode") {
    const { mcpServers, notApplied } = session("opencode").projection
    assert.deepEqual(mcpServers.map((server) => [server.kind, server.origin]), [["http", "plugin"], ["stdio", "plugin"]], "OpenCode StartInput lost a plugin MCP server")
    assert.equal(await fs.realpath(mcpServers[1].cwd), await fs.realpath(path.join(path.dirname(mcpServers[1].command), "skills")))
    assert.deepEqual(notApplied, [])
    await assert.rejects(fs.stat(path.join(generation.root, "harnesses/opencode/opencode.json")), { code: "ENOENT" })
  } else if (mode === "empty") {
    const codex = await prepareCodexProfile({ homeRoot: path.join(home, "shared/codex"), credentials: session("codex").credentials, projection: session("codex").projection })
    const cursor = await composeCursorHome({ root: path.join(home, "shared/cursor"), key: "fixture", personalCursorDir: personalCursor, projection: session("cursor").projection })
    assert.deepEqual(session("codex").projection.pluginSelection, { mode: "selected", selectionHash: "selection-a" })
    assert.deepEqual(session("codex").projection.pluginRoots, [])
    assert.ok(!(await fs.readdir(path.join(cursor.home, ".cursor/plugins/local"))).includes("personal"))
    assert.ok(!(await fs.readFile(path.join(codex.home, "config.toml"), "utf8")).includes("marketplaces"))
    assert.deepEqual([await snapshot(personalCodex), await snapshot(personalCursor)], before)
  } else {
    assert.deepEqual([await snapshot(personalCodex), await snapshot(personalCursor)], before, "activation changed the person's homes")
    const codex = await prepareCodexProfile({ homeRoot: path.join(home, "shared/codex"), credentials: session("codex").credentials, projection: session("codex").projection })
    const cursor = await composeCursorHome({ root: path.join(home, "shared/cursor"), key: "fixture", personalCursorDir: personalCursor, projection: session("cursor").projection })
    if (mode === "selected") {
      assert.deepEqual(session("codex").projection.pluginSelection, { mode: "selected", selectionHash: "selection-a" })
      assert.ok(!(await fs.readdir(path.join(cursor.home, ".cursor/plugins/local"))).includes("personal"))
    }
    assert.match(await fs.readFile(path.join(codex.home, "config.toml"), "utf8"), /marketplaces.claxedo-agent-plugins/)
    assert.equal((await fs.readFile(path.join(codex.home, "config.toml"), "utf8")).split("[marketplaces.claxedo-agent-plugins]").length, 2)
    assert.ok(await fs.stat(path.join(codex.home, "plugins/cache/claxedo-agent-plugins/review/1.0.0/.codex-plugin/plugin.json")))
    const { mcpServers } = JSON.parse(await fs.readFile(path.join(codex.home, "plugins/cache/claxedo-agent-plugins/review/1.0.0/.mcp.json"), "utf8"))
    assert.ok(path.isAbsolute(mcpServers.local.command))
    const result = await promisify(execFile)(mcpServers.local.command, mcpServers.local.args, { cwd: mcpServers.local.cwd })
    assert.equal(await fs.realpath(result.stdout.trim()), await fs.realpath(mcpServers.local.cwd))
    assert.ok((await fs.readdir(path.join(cursor.home, ".cursor/plugins/local"))).some((name) => name.startsWith("claxedo--")))
    const projection = session("codex").projection
    await assert.rejects(prepareCodexProfile({ homeRoot: path.join(home, "shared/codex"),
      credentials: session("codex").credentials, projection: { ...projection,
        pluginRoots: [...projection.pluginRoots, { ...projection.pluginRoots[0], pluginInstanceId: "duplicate-name" }] },
    }), /Duplicate Codex plugin/)
    assert.deepEqual([await snapshot(personalCodex), await snapshot(personalCursor)], before, "composition changed the person's homes")
  }
  console.log(`${mode}: passed`)
}

const [mode = "homes", childHome] = process.argv.slice(2)
if (childHome) await activationLaunchFixture(childHome, mode)
else {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), FIXTURE_HOME_PREFIX))
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [import.meta.filename, mode, home], {
      env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"),
        XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local/share") },
    })
    process.stdout.write(stdout)
  } finally { await fs.rm(home, { recursive: true, force: true }) }
}
