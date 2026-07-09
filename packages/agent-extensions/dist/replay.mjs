import {createRequire as __cr} from 'module';var require=__cr(import.meta.url);

// src/replay.ts
import { execFile } from "child_process";
import crypto3 from "crypto";
import fs7 from "fs/promises";
import os from "os";
import path9 from "path";

// src/fs-safe.ts
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
async function writeFileAtomic(file, data, mode = 420) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  await fs.writeFile(tmp, data, { mode });
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}
async function readFileIfExists(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    const code = err.code;
    if (code === "ENOENT" || code === "ENOTDIR") return void 0;
    throw err;
  }
}
var STATE_LOCK_STALE_MS = 10 * 60 * 1e3;
async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
async function withAgentExtensionStateLock(root, fn) {
  const lock = path.join(root, ".replay-lock");
  await fs.mkdir(root, { recursive: true, mode: 493 });
  while (true) {
    try {
      await fs.mkdir(lock, { mode: 493 });
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const stat = await fs.stat(lock).catch(() => void 0);
      if (stat && Date.now() - stat.mtimeMs > STATE_LOCK_STALE_MS) {
        await fs.rm(lock, { recursive: true, force: true });
        continue;
      }
      await wait(100);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

// src/materialize.ts
import fs5 from "fs/promises";
import path7 from "path";

// src/discovery.ts
import fs2 from "fs/promises";
import path2 from "path";
async function fileExists(file) {
  return fs2.stat(file).then((item) => item.isFile()).catch(() => false);
}
async function dirExists(dir) {
  return fs2.stat(dir).then((item) => item.isDirectory()).catch(() => false);
}
async function readDir(dir) {
  return fs2.readdir(dir, { withFileTypes: true }).catch(() => []);
}
function componentName(fileOrDir) {
  const base = path2.basename(fileOrDir);
  const ext = path2.extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}
async function pluginName(file, fallback) {
  const manifest = JSON.parse(await fs2.readFile(file, "utf8"));
  return typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : fallback;
}
async function discoverSkills(root) {
  const skillsDir = path2.join(root, "skills");
  const conventional = (await Promise.all((await readDir(skillsDir)).filter((entry) => entry.isDirectory()).map(async (entry) => {
    const skillDir = path2.join(skillsDir, entry.name);
    if (!await fileExists(path2.join(skillDir, "SKILL.md"))) return [];
    return [{ type: "skill", name: entry.name, path: skillDir }];
  }))).flat();
  if (conventional.length > 0) return conventional;
  if (!await fileExists(path2.join(root, "SKILL.md"))) return [];
  return [{ type: "skill", name: path2.basename(root), path: root }];
}
async function discoverMcp(root) {
  const mcpDir = path2.join(root, "mcp");
  const conventional = (await readDir(mcpDir)).filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => ({
    type: "mcp",
    name: componentName(entry.name),
    path: path2.join(mcpDir, entry.name)
  }));
  if (conventional.length > 0) return conventional;
  if (await fileExists(path2.join(root, "mcp.json"))) {
    return [{ type: "mcp", name: path2.basename(root), path: path2.join(root, "mcp.json") }];
  }
  if (await fileExists(path2.join(root, ".vscode", "mcp.json"))) {
    return [{ type: "mcp", name: path2.basename(root), path: path2.join(root, ".vscode", "mcp.json") }];
  }
  return [];
}
async function discoverCursorPlugins(root) {
  const pluginsDir = path2.join(root, "plugins", "cursor");
  const nested = (await Promise.all((await readDir(pluginsDir)).filter((entry) => entry.isDirectory()).map(async (entry) => {
    const pluginDir = path2.join(pluginsDir, entry.name);
    if (!await fileExists(path2.join(pluginDir, "plugin.json"))) return [];
    return [{ type: "plugin", runner: "cursor", name: entry.name, path: pluginDir }];
  }))).flat();
  if (nested.length > 0) return nested;
  const conventionalPlugin = path2.join(pluginsDir, "plugin.json");
  if (await fileExists(conventionalPlugin)) {
    return [{
      type: "plugin",
      runner: "cursor",
      name: await pluginName(conventionalPlugin, path2.basename(root)),
      path: pluginsDir
    }];
  }
  const legacyPlugin = path2.join(root, ".cursor-plugin", "plugin.json");
  if (await fileExists(legacyPlugin)) {
    return [{
      type: "plugin",
      runner: "cursor",
      name: await pluginName(legacyPlugin, path2.basename(root)),
      path: root
    }];
  }
  return [];
}
function hookRunner(name) {
  if (name === "claude" || name === "codex" || name === "cursor" || name === "opencode") return name;
  if (name === "droid" || name === "gemini" || name === "mastra") return name;
  return void 0;
}
async function discoverHooks(root) {
  const hooksDir = path2.join(root, "hooks");
  return (await readDir(hooksDir)).flatMap((entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".json")) return [];
    const name = componentName(entry.name);
    const runner = hookRunner(name);
    if (!runner) return [];
    return [{ type: "hook", runner, name, path: path2.join(hooksDir, entry.name) }];
  });
}
async function discoverAgentExtensionComponents(root) {
  if (!await dirExists(root)) return [];
  return [
    ...await discoverSkills(root),
    ...await discoverMcp(root),
    ...await discoverCursorPlugins(root),
    ...await discoverHooks(root)
  ];
}

// src/materializers/cursor.ts
import path4 from "path";

// src/materialization.ts
import fs3 from "fs/promises";
import path3 from "path";

// src/state.ts
var AgentExtensionStateError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentExtensionStateError";
  }
};

// src/materialization.ts
var AgentExtensionMaterializationError = class extends Error {
  constructor(message, code = "agent_extension_materialization_error", details = {}) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "AgentExtensionMaterializationError";
  }
};
async function readMaterializedRuntimeRecord(file) {
  const raw = await readFileIfExists(file);
  if (raw === void 0) return { version: 1, packages: {} };
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new AgentExtensionStateError(
      `Materialized Agent Extension record ${file} is not valid JSON; fix or remove it (it is the ownership record that guards deletions): ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return {
    version: 1,
    packages: data.packages ?? {}
  };
}
async function writeMaterializedRuntimeRecord(file, record) {
  await fs3.mkdir(path3.dirname(file), { recursive: true, mode: 493 });
  await writeFileAtomic(file, JSON.stringify({
    version: 1,
    packages: Object.fromEntries(Object.entries(record.packages).sort(([a], [b]) => a.localeCompare(b)))
  }, null, 2) + "\n");
}
function componentOwnedBy(record, targetPath, ownerId) {
  return record?.packages[ownerId]?.components.some((item) => item.path === targetPath && item.status === "applied") ?? false;
}
async function sameRealPath(a, b) {
  const [left, right] = await Promise.all([
    fs3.realpath(a).catch(() => null),
    fs3.realpath(b).catch(() => null)
  ]);
  return !!left && left === right;
}
function agentExtensionCacheKey(input) {
  const parts = path3.resolve(input).split(path3.sep);
  const root = parts.findIndex(
    (part, index) => part === ".agent-extensions" && parts[index + 1] === "cache"
  );
  return root === -1 ? void 0 : parts.slice(root + 2).join("/");
}
async function isGeneratedCacheSymlinkToSamePackage(input) {
  if (!input.existing.isSymbolicLink()) return false;
  const [source2, target] = await Promise.all([
    fs3.realpath(input.sourceDir).catch(() => void 0),
    fs3.realpath(input.targetDir).catch(() => void 0)
  ]);
  if (!source2 || !target) return false;
  const sourceKey = agentExtensionCacheKey(source2);
  return !!sourceKey && sourceKey === agentExtensionCacheKey(target);
}
async function emptyDir(target) {
  await fs3.rm(target, { recursive: true, force: true });
  await fs3.mkdir(path3.dirname(target), { recursive: true, mode: 493 });
}
async function linkOrCopyOwnedDirectory(input) {
  if (path3.resolve(input.sourceDir) === path3.resolve(input.targetDir) || await sameRealPath(input.sourceDir, input.targetDir)) {
    if (componentOwnedBy(input.record, input.targetDir, input.ownerId)) {
      return { status: "applied", path: input.targetDir };
    }
    return { status: "skipped", reason: "source already at target path", path: input.targetDir };
  }
  const existing = await fs3.lstat(input.targetDir).catch(() => null);
  if (existing) {
    const owned = componentOwnedBy(input.record, input.targetDir, input.ownerId);
    const adoptable = owned ? false : await isGeneratedCacheSymlinkToSamePackage({
      sourceDir: input.sourceDir,
      targetDir: input.targetDir,
      existing
    });
    if (!owned && !adoptable) {
      throw new AgentExtensionMaterializationError(
        `Refusing to overwrite unmanaged Agent Extension artifact at ${input.targetDir}`,
        "agent_extension_target_path_conflict",
        {
          ownerId: input.ownerId,
          targetPath: input.targetDir
        }
      );
    }
    if (owned && !input.replaceOwned) {
      return { status: "drifted", reason: "owned artifact differs from cached source", path: input.targetDir };
    }
  }
  await emptyDir(input.targetDir);
  try {
    await (input.symlink ?? fs3.symlink)(input.sourceDir, input.targetDir, "dir");
    return { status: "applied", path: input.targetDir };
  } catch {
    await fs3.cp(input.sourceDir, input.targetDir, { recursive: true, force: true });
    return { status: "applied", path: input.targetDir, reason: "copied because symlink failed" };
  }
}

// src/materializers/cursor.ts
function cursorLocalPluginDir(input) {
  return path4.join(input.homeDir, ".cursor", "plugins", "local", input.pluginName);
}
async function materializeCursorLocalPlugin(input) {
  const result = await linkOrCopyOwnedDirectory({
    sourceDir: input.packageDir,
    targetDir: cursorLocalPluginDir(input),
    ownerId: input.ownerId,
    record: input.record,
    ...input.replaceOwned ? { replaceOwned: input.replaceOwned } : {},
    ...input.symlink ? { symlink: input.symlink } : {}
  });
  return {
    runner: "cursor",
    component: input.pluginName,
    type: "plugin",
    status: result.status,
    ...result.reason ? { reason: result.reason } : {},
    path: result.path
  };
}

// src/materializers/mcp.ts
import fs4 from "fs/promises";
import path5 from "path";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";
function asRecord(input) {
  return input && typeof input === "object" && !Array.isArray(input) ? input : {};
}
function sortedObject(input) {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
}
function normalizeStandaloneMcpConfig(input) {
  const root = asRecord(input.mcpServers ?? input.servers);
  const servers = Object.fromEntries(Object.entries(root).map(([name, value]) => {
    const cfg = asRecord(value);
    if (typeof cfg.command === "string") {
      return [name, {
        command: cfg.command,
        ...Array.isArray(cfg.args) ? { args: cfg.args.filter((item) => typeof item === "string") } : {},
        ...Object.keys(asRecord(cfg.env)).length > 0 ? { env: asRecord(cfg.env) } : {}
      }];
    }
    if (typeof cfg.url === "string") {
      return [name, {
        url: cfg.url,
        ...Object.keys(asRecord(cfg.headers)).length > 0 ? { headers: asRecord(cfg.headers) } : {}
      }];
    }
    throw new AgentExtensionMaterializationError(`MCP server ${name} must include command or url`);
  }));
  if (Object.keys(servers).length === 0) throw new AgentExtensionMaterializationError("Standalone MCP config must declare at least one server");
  return { servers: sortedObject(servers) };
}
function mcpTargetPath(input) {
  if (input.runner === "cursor") {
    if (input.scope === "project") {
      if (!input.projectDir) throw new Error("projectDir is required for project Cursor MCP materialization");
      return path5.join(input.projectDir, ".cursor", "mcp.json");
    }
    if (!input.homeDir) throw new Error("homeDir is required for machine Cursor MCP materialization");
    return path5.join(input.homeDir, ".cursor", "mcp.json");
  }
  if (input.runner === "claude") {
    if (input.scope === "project") {
      if (!input.projectDir) throw new Error("projectDir is required for project Claude MCP materialization");
      return path5.join(input.projectDir, ".mcp.json");
    }
    if (!input.homeDir) throw new Error("homeDir is required for machine Claude MCP materialization");
    return path5.join(input.homeDir, ".claude.json");
  }
  if (input.runner === "codex") {
    if (input.scope === "project") {
      if (!input.projectDir) throw new Error("projectDir is required for project Codex MCP materialization");
      return path5.join(input.projectDir, ".codex", "config.toml");
    }
    if (!input.homeDir) throw new Error("homeDir is required for machine Codex MCP materialization");
    return path5.join(input.homeDir, ".codex", "config.toml");
  }
  if (input.runner === "opencode") {
    if (input.scope === "project") {
      if (!input.projectDir) throw new Error("projectDir is required for project OpenCode MCP materialization");
      return path5.join(input.projectDir, ".opencode", "opencode.jsonc");
    }
    if (!input.homeDir) throw new Error("homeDir is required for machine OpenCode MCP materialization");
    return path5.join(input.homeDir, ".config", "opencode", "opencode.jsonc");
  }
  return void 0;
}
function componentOwned(input) {
  return input.record?.packages[input.ownerId]?.components.some(
    (item) => item.path === input.path && item.component === input.component && item.status === "applied"
  ) ?? false;
}
function mcpComponents(input) {
  return input.names.map((name) => ({
    runner: input.runner,
    component: name,
    type: "mcp",
    status: input.drifted?.has(name) ? "drifted" : input.existing && !input.existing.has(name) ? "skipped" : "applied",
    ...input.drifted?.has(name) ? { reason: "owned MCP config differs from desired source" } : {},
    ...input.existing && !input.existing.has(name) ? { reason: "not applied because another owned MCP config drifted" } : {},
    path: input.target
  }));
}
function toRunnerMcpServers(runner, config) {
  return sortedObject(Object.fromEntries(Object.entries(config.servers).map(([name, cfg]) => {
    if ("url" in cfg) return [name, cfg];
    if (runner === "claude") return [name, {
      type: "stdio",
      command: cfg.command,
      args: cfg.args ?? [],
      env: cfg.env ?? {}
    }];
    return [name, {
      command: cfg.command,
      args: cfg.args ?? [],
      env: cfg.env ?? {}
    }];
  })));
}
function toOpenCodeMcpServers(config) {
  return sortedObject(Object.fromEntries(Object.entries(config.servers).map(([name, cfg]) => {
    if ("url" in cfg) return [name, {
      type: "remote",
      url: cfg.url,
      enabled: true,
      ...cfg.headers && Object.keys(cfg.headers).length > 0 ? { headers: cfg.headers } : {}
    }];
    return [name, {
      type: "local",
      command: [cfg.command, ...cfg.args ?? []],
      enabled: true,
      ...cfg.env && Object.keys(cfg.env).length > 0 ? { environment: cfg.env } : {}
    }];
  })));
}
function tomlString(input) {
  return `"${input.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
function tomlKey(input) {
  return /^[A-Za-z0-9_-]+$/.test(input) ? input : tomlString(input);
}
function tomlArray(input) {
  return `[${input.map(tomlString).join(", ")}]`;
}
function tomlInlineTable(input) {
  return `{ ${Object.entries(sortedObject(input)).map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`).join(", ")} }`;
}
function codexMcpSection(name, config) {
  const lines = [`[mcp_servers.${tomlKey(name)}]`];
  if ("url" in config) {
    lines.push(`url = ${tomlString(config.url)}`);
    if (config.headers && Object.keys(config.headers).length > 0) lines.push(`headers = ${tomlInlineTable(config.headers)}`);
    return `${lines.join("\n")}
`;
  }
  lines.push(`command = ${tomlString(config.command)}`);
  if (config.args) lines.push(`args = ${tomlArray(config.args)}`);
  if (config.env && Object.keys(config.env).length > 0) lines.push(`env = ${tomlInlineTable(config.env)}`);
  return `${lines.join("\n")}
`;
}
function unquoteTomlKey(input) {
  return input.startsWith('"') && input.endsWith('"') ? input.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\") : input;
}
function codexMcpSections(raw) {
  const lines = raw.split(/(?<=\n)/);
  const sections = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*\[mcp_servers\.((?:"(?:\\.|[^"])+")|[A-Za-z0-9_-]+)\]\s*$/);
    const start = offset;
    offset += lines[i].length;
    if (!match) continue;
    let end = offset;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*\[.+\]\s*$/.test(lines[j])) break;
      end += lines[j].length;
    }
    sections.push({ name: unquoteTomlKey(match[1]), start, end, body: raw.slice(start, end) });
  }
  return sections;
}
async function readText(file) {
  return await readFileIfExists(file) ?? "";
}
async function readJson(file) {
  const raw = await readFileIfExists(file);
  if (raw === void 0 || !raw.trim()) return {};
  return readJsonFromText(raw, file);
}
function readJsonFromText(raw, file) {
  const errors = [];
  const parsed = parseJsonc(raw, errors);
  if (errors.length > 0) {
    throw new AgentExtensionMaterializationError(
      `MCP target config ${file} contains invalid JSON; fix it before materializing (refusing to rewrite a file that cannot be parsed)`,
      "agent_extension_materialization_error",
      { targetPath: file }
    );
  }
  return asRecord(parsed);
}
async function writeJson(file, input) {
  await fs4.mkdir(path5.dirname(file), { recursive: true, mode: 493 });
  await writeFileAtomic(file, JSON.stringify(input, null, 2) + "\n");
}
var JSONC_FORMAT = { formattingOptions: { tabSize: 2, insertSpaces: true } };
async function removeStandaloneMcpEntries(input) {
  if (input.file.endsWith(".toml")) {
    const raw = await readText(input.file);
    if (!raw) return;
    const names = new Set(input.names);
    const sections = codexMcpSections(raw).filter((section) => names.has(section.name));
    if (sections.length === 0) return;
    const next2 = [...sections].reverse().reduce((text, section) => `${text.slice(0, section.start)}${text.slice(section.end)}`, raw);
    await writeFileAtomic(input.file, next2.replace(/\n{3,}/g, "\n\n"));
    return;
  }
  if (input.file.endsWith("opencode.jsonc") || input.file.endsWith("opencode.json")) {
    const raw = await readText(input.file);
    if (!raw.trim()) return;
    readJsonFromText(raw, input.file);
    let text = raw;
    for (const name of input.names) {
      text = applyEdits(text, modify(text, ["mcp", name], void 0, JSONC_FORMAT));
    }
    const withoutEntries = readJsonFromText(text, input.file);
    if (Object.keys(asRecord(withoutEntries.mcp)).length === 0) {
      text = applyEdits(text, modify(text, ["mcp"], void 0, JSONC_FORMAT));
    }
    if (Object.keys(readJsonFromText(text, input.file)).length === 0) {
      await fs4.rm(input.file, { force: true });
      return;
    }
    await writeFileAtomic(input.file, `${text.trimEnd()}
`);
    return;
  }
  const root = await readJson(input.file);
  const current = asRecord(root.mcpServers);
  for (const name of input.names) {
    delete current[name];
  }
  const next = { ...root };
  if (Object.keys(current).length > 0) next.mcpServers = sortedObject(current);
  else delete next.mcpServers;
  if (Object.keys(next).length === 0) {
    await fs4.rm(input.file, { force: true });
    return;
  }
  await writeJson(input.file, next);
}
async function materializeStandaloneMcp(input) {
  const target = mcpTargetPath(input);
  if (!target) {
    return Object.keys(input.config.servers).map((name) => ({
      runner: input.runner,
      component: name,
      type: "mcp",
      status: "skipped",
      reason: "native MCP config path not verified"
    }));
  }
  if (input.runner === "codex") {
    const raw = await readText(target);
    const sections = codexMcpSections(raw);
    const nextSections = input.config.servers;
    const drifted2 = /* @__PURE__ */ new Set();
    for (const [name, next] of Object.entries(nextSections)) {
      const current2 = sections.find((section) => section.name === name);
      if (!current2) continue;
      if (!componentOwned({ record: input.record, ownerId: input.ownerId, path: target, component: name })) {
        throw new AgentExtensionMaterializationError(
          `MCP server ${name} already exists in ${target}`,
          "agent_extension_mcp_server_conflict",
          {
            ownerId: input.ownerId,
            runner: input.runner,
            serverName: name,
            targetPath: target
          }
        );
      }
      if (!input.replaceOwned && current2.body.trim() !== codexMcpSection(name, next).trim()) {
        drifted2.add(name);
      }
    }
    if (drifted2.size > 0) {
      return mcpComponents({
        runner: input.runner,
        target,
        names: Object.keys(nextSections),
        drifted: drifted2,
        existing: new Set(sections.map((section) => section.name))
      });
    }
    const names = new Set(Object.keys(nextSections));
    const withoutOwned = sections.filter((section) => names.has(section.name)).reverse().reduce((text, section) => `${text.slice(0, section.start)}${text.slice(section.end)}`, raw).replace(/\n{3,}/g, "\n\n");
    const prefix = withoutOwned.trim() ? `${withoutOwned.trimEnd()}

` : "";
    await fs4.mkdir(path5.dirname(target), { recursive: true, mode: 493 });
    await writeFileAtomic(target, `${prefix}${Object.entries(nextSections).map(([name, cfg]) => codexMcpSection(name, cfg)).join("\n")}`);
    return mcpComponents({ runner: input.runner, target, names: Object.keys(nextSections) });
  }
  if (input.runner === "opencode") {
    const raw = await readText(target);
    const root2 = raw.trim() ? readJsonFromText(raw, target) : {};
    const current2 = asRecord(root2.mcp);
    const nextServers2 = toOpenCodeMcpServers(input.config);
    const drifted2 = /* @__PURE__ */ new Set();
    for (const [name, next2] of Object.entries(nextServers2)) {
      if (current2[name] === void 0) continue;
      if (!componentOwned({ record: input.record, ownerId: input.ownerId, path: target, component: name })) {
        throw new AgentExtensionMaterializationError(
          `MCP server ${name} already exists in ${target}`,
          "agent_extension_mcp_server_conflict",
          {
            ownerId: input.ownerId,
            runner: input.runner,
            serverName: name,
            targetPath: target
          }
        );
      }
      if (!input.replaceOwned && JSON.stringify(current2[name]) !== JSON.stringify(next2)) {
        drifted2.add(name);
      }
    }
    if (drifted2.size > 0) {
      return mcpComponents({
        runner: input.runner,
        target,
        names: Object.keys(nextServers2),
        drifted: drifted2,
        existing: new Set(Object.keys(current2))
      });
    }
    const next = Object.entries(nextServers2).reduce((text, [name, value]) => applyEdits(text, modify(text, ["mcp", name], value, {
      formattingOptions: { tabSize: 2, insertSpaces: true }
    })), raw.trim() ? raw : "{}");
    await fs4.mkdir(path5.dirname(target), { recursive: true, mode: 493 });
    await writeFileAtomic(target, `${next.trimEnd()}
`);
    return mcpComponents({ runner: input.runner, target, names: Object.keys(nextServers2) });
  }
  const root = await readJson(target);
  const current = asRecord(root.mcpServers);
  const nextServers = toRunnerMcpServers(input.runner, input.config);
  const drifted = /* @__PURE__ */ new Set();
  for (const [name, next] of Object.entries(nextServers)) {
    if (current[name] === void 0) continue;
    if (!componentOwned({ record: input.record, ownerId: input.ownerId, path: target, component: name })) {
      throw new AgentExtensionMaterializationError(
        `MCP server ${name} already exists in ${target}`,
        "agent_extension_mcp_server_conflict",
        {
          ownerId: input.ownerId,
          runner: input.runner,
          serverName: name,
          targetPath: target
        }
      );
    }
    if (!input.replaceOwned && JSON.stringify(current[name]) !== JSON.stringify(next)) {
      drifted.add(name);
    }
  }
  if (drifted.size > 0) {
    return mcpComponents({
      runner: input.runner,
      target,
      names: Object.keys(nextServers),
      drifted,
      existing: new Set(Object.keys(current))
    });
  }
  await writeJson(target, {
    ...root,
    mcpServers: {
      ...current,
      ...nextServers
    }
  });
  return mcpComponents({ runner: input.runner, target, names: Object.keys(nextServers) });
}

// src/materializers/skills.ts
import path6 from "path";
function skillTargetDir(input) {
  if (input.scope === "project") {
    if (!input.projectDir) throw new Error("projectDir is required for project skill materialization");
    if (input.runner === "claude") return path6.join(input.projectDir, ".claude", "skills", input.name);
    if (input.runner === "codex") return path6.join(input.projectDir, ".agents", "skills", input.name);
    if (input.runner === "opencode") return path6.join(input.projectDir, ".opencode", "skills", input.name);
    return path6.join(input.projectDir, ".cursor", "skills", input.name);
  }
  if (!input.homeDir) throw new Error("homeDir is required for machine skill materialization");
  if (input.runner === "claude") return path6.join(input.homeDir, ".claude", "skills", input.name);
  if (input.runner === "codex") return path6.join(input.homeDir, ".codex", "skills", input.name);
  if (input.runner === "opencode") return path6.join(input.homeDir, ".config", "opencode", "skills", input.name);
  return path6.join(input.homeDir, ".cursor", "skills", input.name);
}
async function materializeStandaloneSkill(input) {
  const result = await linkOrCopyOwnedDirectory({
    sourceDir: input.skillDir,
    targetDir: skillTargetDir(input),
    ownerId: input.ownerId,
    record: input.record,
    ...input.replaceOwned ? { replaceOwned: input.replaceOwned } : {},
    ...input.symlink ? { symlink: input.symlink } : {}
  });
  return {
    runner: input.runner,
    component: input.name,
    type: "skill",
    status: result.status,
    ...result.reason ? { reason: result.reason } : {},
    path: result.path
  };
}

// src/types.ts
var HARNESS_TARGETS = ["opencode", "claude", "codex", "cursor"];
var FIRST_PARTY_AGENT_EXTENSIONS_DIR = "agent-extensions";
function isHarnessTarget(input) {
  return HARNESS_TARGETS.includes(input);
}

// src/materialize.ts
function sorted(input) {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
}
function now(input) {
  return typeof input.now === "function" ? input.now() : input.now ?? Date.now();
}
function scope(input) {
  return input.desired.scope === "machine" ? "machine" : "project";
}
function targets(input) {
  return (input.desired.targets ?? []).filter(isHarnessTarget);
}
function packageName(input, packageRoot) {
  return input.desired.package_name ?? input.desired.id ?? path7.basename(packageRoot);
}
function packageNameWithoutRoot(input) {
  return input.desired.package_name ?? input.desired.id;
}
function status(components, fallback) {
  if (components.length === 0) return fallback === "failed" || fallback === "drifted" ? fallback : "partial";
  if (components.every((item) => item.status === "skipped")) return "partial";
  if (components.some((item) => item.status === "failed")) return "failed";
  if (components.some((item) => item.status === "drifted")) return "drifted";
  if (components.some((item) => item.status === "skipped")) return "partial";
  return "applied";
}
async function readJson2(file) {
  return JSON.parse(await fs5.readFile(file, "utf8"));
}
var CLAXEDO_MCP_MANAGED_ENV = /* @__PURE__ */ new Set([
  "CLAXEDO_SERVER_URL",
  "OPENCODE_API_URL",
  "OPENCODE_API_DIR",
  "CLAXEDO_WORKSPACE_ID"
]);
var CLAXEDO_MCP_AUTH_ENV = /* @__PURE__ */ new Set([
  "CLAXEDO_LOCAL_TOKEN",
  "CLAXEDO_JIT_TOKEN",
  "CLAXEDO_BROKER_TOKEN",
  "CLAXEDO_MCP_BROKER_TOKEN",
  "CLAXEDO_AUTH_TOKEN",
  "CLAXEDO_API_TOKEN"
]);
function textEnv(name) {
  const value = process.env[name]?.trim();
  return value || void 0;
}
function claxedoMcpServerUrl() {
  return textEnv("CLAXEDO_SERVER_URL") ?? "http://127.0.0.1:3001";
}
function claxedoMcpWorkspaceId() {
  return textEnv("CLAXEDO_WORKSPACE_ID") ?? textEnv("CLAXEDO_WR_WORKSPACE_ID");
}
function isFirstPartyClaxedoMcpInstall(input) {
  const source2 = input.desired.source;
  return input.desired.id === "claxedo-mcp" && source2.type === "github" && source2.owner === "kyashrathore" && source2.repo?.toLowerCase() === "claxedo" && source2.ref === "dev" && source2.package_path === "packages/claxedo-mcp";
}
function managedClaxedoMcpEnv(input) {
  return {
    ...Object.fromEntries(Object.entries(input.env ?? {}).filter(
      ([key, value]) => typeof value === "string" && !CLAXEDO_MCP_MANAGED_ENV.has(key) && !CLAXEDO_MCP_AUTH_ENV.has(key)
    )),
    CLAXEDO_SERVER_URL: claxedoMcpServerUrl(),
    ...input.targetScope === "project" ? { OPENCODE_API_DIR: input.projectDir } : {},
    ...claxedoMcpWorkspaceId() ? { CLAXEDO_WORKSPACE_ID: claxedoMcpWorkspaceId() } : {}
  };
}
function managedClaxedoMcpConfig(input) {
  return {
    servers: sorted(Object.fromEntries(Object.entries(input.config.servers).map(([name, config]) => {
      if (name !== "claxedo" || !("command" in config)) return [name, config];
      return [name, {
        ...config,
        env: managedClaxedoMcpEnv({
          env: config.env,
          projectDir: input.projectDir,
          targetScope: input.targetScope
        })
      }];
    })))
  };
}
async function removeTreeOrLink(target) {
  const stat = await fs5.lstat(target).catch(() => void 0);
  if (!stat) return;
  await fs5.rm(target, { recursive: stat.isDirectory() && !stat.isSymbolicLink(), force: true });
}
async function removeMaterializedComponent(component) {
  if (component.status !== "applied" || !component.path) return;
  if (component.type !== "mcp") {
    await removeTreeOrLink(component.path);
    return;
  }
  await removeStandaloneMcpEntries({ file: component.path, names: [component.component] });
}
async function removeStaleMaterializedComponents(previous, next) {
  const nextComponents = new Set(Object.values(next.packages).flatMap(
    (pkg) => pkg.components.flatMap(
      (component) => component.path ? [`${component.type}
${component.path}
${component.component}`] : []
    )
  ));
  await Promise.all(Object.values(previous.packages).flatMap(
    (pkg) => pkg.components.flatMap(
      (component) => component.status === "applied" && component.path && !nextComponents.has(`${component.type}
${component.path}
${component.component}`) ? [removeMaterializedComponent(component)] : []
    )
  ));
}
async function materializeDiscoveredComponent(input) {
  if (input.component.type === "skill") {
    return [await materializeStandaloneSkill({
      skillDir: input.component.path,
      name: path7.resolve(input.component.path) === path7.resolve(input.packageRoot) ? input.packageName : input.component.name,
      runner: input.runner,
      scope: input.targetScope,
      ownerId: input.ownerId,
      projectDir: input.projectDir,
      homeDir: input.homeDir,
      record: input.previous,
      replaceOwned: input.replaceOwned
    })];
  }
  if (input.component.type === "plugin") {
    if (input.runner === input.component.runner) {
      return [await materializeCursorLocalPlugin({
        packageDir: input.component.path,
        pluginName: input.component.name,
        ownerId: input.ownerId,
        homeDir: input.install.desired.scope === "workspace" ? input.projectDir : input.homeDir,
        record: input.previous,
        replaceOwned: input.replaceOwned
      })];
    }
    return [{
      runner: input.runner,
      component: input.component.name,
      type: "plugin",
      status: "skipped",
      reason: "native plugin install path not verified"
    }];
  }
  if (input.component.type === "mcp") {
    const mcpConfig = normalizeStandaloneMcpConfig(await readJson2(input.component.path));
    return await materializeStandaloneMcp({
      config: isFirstPartyClaxedoMcpInstall(input.install) ? managedClaxedoMcpConfig({ config: mcpConfig, projectDir: input.projectDir, targetScope: input.targetScope }) : mcpConfig,
      runner: input.runner,
      scope: input.targetScope,
      ownerId: input.ownerId,
      projectDir: input.projectDir,
      homeDir: input.homeDir,
      record: input.previous,
      replaceOwned: input.replaceOwned
    });
  }
  return [{
    runner: input.runner,
    component: input.component.name,
    type: "hook",
    status: "skipped",
    reason: "agent hook package materialization is not implemented yet"
  }];
}
function componentKey(component) {
  return `${component.runner}
${component.type}
${component.component}`;
}
function withPreviousApplied(components, previous) {
  const seen = new Set(components.map(componentKey));
  return [
    ...components,
    ...(previous?.components ?? []).filter((component) => component.status === "applied" && !seen.has(componentKey(component)))
  ];
}
async function materializePackage(input) {
  const name = packageName(input.install, input.packageRoot);
  const ownerId = input.install.desired.id;
  const targetScope = scope(input.install);
  const components = [];
  const failures = [];
  const discovered = await discoverAgentExtensionComponents(input.packageRoot);
  for (const runner of targets(input.install)) {
    if (discovered.length > 0) {
      for (const component of discovered) {
        try {
          components.push(...await materializeDiscoveredComponent({
            component,
            install: input.install,
            runner,
            packageRoot: input.packageRoot,
            packageName: name,
            targetScope,
            ownerId,
            projectDir: input.projectDir,
            homeDir: input.homeDir,
            previous: input.previous,
            replaceOwned: input.replaceOwned
          }));
        } catch (err) {
          failures.push(err);
          components.push({
            runner,
            component: component.name,
            type: component.type,
            status: "failed",
            reason: err instanceof Error ? err.message : String(err)
          });
        }
      }
      continue;
    }
    components.push({
      runner,
      component: name,
      type: "plugin",
      status: "skipped",
      reason: "unsupported package shape"
    });
  }
  const recorded = failures.length > 0 ? withPreviousApplied(components, input.previous.packages[ownerId]) : components;
  return {
    package: {
      package_name: name,
      source: input.install.desired.source,
      resolved_sha: input.install.lock?.resolved_sha ?? "",
      enabled: true,
      targets: targets(input.install),
      components: recorded,
      materialized_at: input.materializedAt,
      status: status(recorded, input.install.status)
    },
    failures
  };
}
async function materializeAgentExtensionSnapshot(input) {
  const materializedFile = path7.join(input.stateRoot, "materialized.json");
  const previous = await readMaterializedRuntimeRecord(materializedFile);
  const materializedAt = now(input);
  const failures = [];
  const packageEntries = (await Promise.all(input.installs.map(async (install) => {
    const existing = previous.packages[install.desired.id];
    if (install.desired.enabled === false) {
      return [[install.desired.id, {
        package_name: packageNameWithoutRoot(install),
        source: install.desired.source,
        resolved_sha: install.lock?.resolved_sha ?? existing?.resolved_sha ?? "",
        enabled: false,
        targets: targets(install),
        components: [],
        materialized_at: materializedAt,
        status: "disabled"
      }]];
    }
    const packageRoot = input.packageRoots[install.desired.id];
    if (!packageRoot && existing && existing.resolved_sha === install.lock?.resolved_sha && JSON.stringify(existing.targets) === JSON.stringify(targets(install)) && existing.status !== "failed" && existing.status !== "drifted") {
      return [[install.desired.id, existing]];
    }
    if (!packageRoot) return [];
    const result = await materializePackage({
      install,
      packageRoot,
      projectDir: input.projectDir,
      homeDir: input.homeDir,
      previous,
      materializedAt,
      replaceOwned: input.replaceOwned ?? !!existing
    });
    failures.push(...result.failures);
    return [[install.desired.id, result.package]];
  }))).flat();
  const packages = sorted(Object.fromEntries(packageEntries));
  const next = {
    version: 1,
    packages
  };
  await removeStaleMaterializedComponents(previous, next);
  await writeMaterializedRuntimeRecord(materializedFile, next);
  if (failures.length > 0) throw failures[0];
  return readMaterializedRuntimeRecord(materializedFile);
}

// src/cache.ts
import fs6 from "fs/promises";
import path8 from "path";
import crypto2 from "crypto";

// src/source.ts
var AgentExtensionSourceError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentExtensionSourceError";
  }
};
function safeRelativePath(input, label = "path") {
  const trimmed = input.trim();
  if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) throw new AgentExtensionSourceError(`${label} must be relative`);
  const value = trimmed.replace(/\/+$/g, "");
  if (!value) throw new AgentExtensionSourceError(`${label} must be a non-empty relative path`);
  if (input.includes("\\") || value.includes("\\")) throw new AgentExtensionSourceError(`${label} must not contain backslashes`);
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new AgentExtensionSourceError(`${label} must stay inside the package root`);
  }
  return parts.join("/");
}

// src/cache.ts
var AgentExtensionCacheError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentExtensionCacheError";
  }
};
async function walkFiles(root, current = root) {
  const entries = (await fs6.readdir(current, { withFileTypes: true })).filter((entry) => !(entry.isDirectory() && entry.name === ".git"));
  const nested = await Promise.all(entries.map(async (entry) => {
    const full = path8.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new AgentExtensionCacheError(`Cache source symlinks are not supported: ${path8.relative(root, full)}`);
    }
    if (entry.isDirectory()) return walkFiles(root, full);
    if (entry.isFile()) return [full];
    return [];
  }));
  return nested.flat();
}
async function digestDirectory(root) {
  const hash = crypto2.createHash("sha256");
  const realRoot = await fs6.realpath(root);
  const files = (await walkFiles(realRoot)).sort((a, b) => path8.relative(realRoot, a).localeCompare(path8.relative(realRoot, b)));
  for (const file of files) {
    const relative2 = path8.relative(realRoot, file).split(path8.sep).join("/");
    hash.update(relative2);
    hash.update("\0");
    hash.update(await fs6.readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

// src/fetch.ts
import { execFile as nodeExecFile } from "child_process";
import { promisify } from "util";
var execFileAsync = promisify(nodeExecFile);
function githubRepoUrl(source2) {
  return `https://github.com/${source2.owner}/${source2.repo}.git`;
}

// src/replay.ts
function projectDirDefault() {
  return process.env.CLAXEDO_WR_DIRECTORY ?? process.cwd();
}
function execFileDefault(file, args, options) {
  if (file !== "git") throw new Error(`Unsupported Agent Extension exec binary: ${file}`);
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd: options?.cwd,
      maxBuffer: 50 * 1024 * 1024,
      timeout: 3e4
    }, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
function sorted2(input) {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
}
function rec(input) {
  return input && typeof input === "object" && !Array.isArray(input) ? input : {};
}
function str(input) {
  return typeof input === "string" && input.trim() ? input.trim() : void 0;
}
function stringList(input) {
  return Array.isArray(input) ? input.filter((item) => typeof item === "string") : [];
}
function packageSource(input) {
  const value = rec(input);
  return {
    type: str(value.type) ?? "unknown",
    ...typeof value.owner === "string" ? { owner: value.owner } : {},
    ...typeof value.repo === "string" ? { repo: value.repo } : {},
    ...typeof value.ref === "string" ? { ref: value.ref } : {},
    ...typeof value.package_path === "string" ? { package_path: value.package_path } : {}
  };
}
function relative(input) {
  if (!input) return void 0;
  try {
    return safeRelativePath(input, "Agent Extension package path");
  } catch {
    throw new Error("Agent Extension package path must stay inside the source root");
  }
}
function source(input) {
  const value = rec(input.desired.source);
  if (value.type === "project") {
    return {
      type: "project",
      packagePath: relative(str(value.package_path)) ?? FIRST_PARTY_AGENT_EXTENSIONS_DIR
    };
  }
  const owner = str(value.owner);
  const repo = str(value.repo);
  if (value.type !== "github" || !owner || !repo) throw new Error(`Unsupported Agent Extension source for ${String(input.desired.id ?? "unknown")}`);
  return {
    type: "github",
    owner,
    repo,
    packagePath: relative(str(value.package_path))
  };
}
function expectedDigest(input) {
  const lock = rec(input.lock);
  const component = str(rec(lock.component_digests).package);
  return component ?? str(rec(lock.manifest_digests).package);
}
async function verifyPackageDigest(input) {
  const expected = expectedDigest(input.install);
  if (!expected) return;
  const actual = await digestDirectory(input.packageRoot);
  if (actual !== expected) {
    throw new Error(`Agent Extension ${String(input.install.desired.id ?? "unknown")} cache checksum mismatch`);
  }
}
function resolvedSha(input) {
  const sha = str(input.lock?.resolved_sha);
  if (!sha) throw new Error(`Agent Extension ${String(input.desired.id ?? "unknown")} is missing resolved SHA`);
  if (!/^[A-Fa-f0-9]{7,64}$/.test(sha)) {
    throw new Error(`Agent Extension ${String(input.desired.id ?? "unknown")} resolved SHA must be a hex commit id`);
  }
  return sha.toLowerCase();
}
async function fetchToCache(input) {
  const info = source(input.install);
  if (info.type !== "github") throw new Error(`Unsupported Agent Extension source for ${String(input.install.desired.id ?? "unknown")}`);
  const sha = resolvedSha(input.install);
  const shaRoot = path9.join(input.cacheRoot, sha);
  const target = info.packagePath ? path9.join(shaRoot, info.packagePath) : shaRoot;
  if (await fs7.stat(target).then((stat) => stat.isDirectory()).catch(() => false)) return target;
  const root = await fs7.mkdtemp(path9.join(input.tempRoot, "claxedo-runtime-extension-"));
  try {
    await input.execFile("git", ["init", root]);
    await input.execFile("git", ["remote", "add", "origin", githubRepoUrl({
      type: "github",
      owner: info.owner,
      repo: info.repo
    })], { cwd: root });
    await input.execFile("git", ["fetch", "--depth", "1", "origin", sha], { cwd: root });
    await input.execFile("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: root });
    const sourceRoot = info.packagePath ? path9.join(root, info.packagePath) : root;
    const staging = `${target}.${crypto3.randomBytes(6).toString("hex")}.tmp`;
    await fs7.mkdir(path9.dirname(target), { recursive: true, mode: 493 });
    await fs7.cp(sourceRoot, staging, {
      recursive: true,
      force: true,
      filter: (source2) => !path9.relative(sourceRoot, source2).split(path9.sep).includes(".git")
    });
    try {
      await fs7.rm(target, { recursive: true, force: true });
      await fs7.rename(staging, target);
    } catch (err) {
      await fs7.rm(staging, { recursive: true, force: true });
      throw err;
    }
    return target;
  } finally {
    await fs7.rm(root, { recursive: true, force: true });
  }
}
async function resolveProjectPackageRoot(input) {
  const info = source(input.install);
  if (info.type !== "project") return void 0;
  const root = path9.join(input.projectDir, info.packagePath);
  if (!await fs7.stat(root).then((stat) => stat.isDirectory()).catch(() => false)) {
    throw new Error(`Project Agent Extension root does not exist: ${info.packagePath}`);
  }
  return root;
}
function canonicalInstall(input) {
  if (typeof input.desired.id !== "string") return;
  return {
    desired: {
      id: input.desired.id,
      ...typeof input.desired.package_name === "string" ? { package_name: input.desired.package_name } : {},
      source: packageSource(input.desired.source),
      ...typeof input.desired.scope === "string" ? { scope: input.desired.scope } : {},
      ...typeof input.desired.enabled === "boolean" ? { enabled: input.desired.enabled } : {},
      targets: stringList(input.desired.targets)
    },
    ...input.lock ? { lock: { ...typeof input.lock.resolved_sha === "string" ? { resolved_sha: input.lock.resolved_sha } : {} } } : {},
    ...typeof input.status === "string" ? { status: input.status } : {}
  };
}
async function packageRoots(input) {
  const entries = (await Promise.all(input.installs.map(async (install) => {
    if (typeof install.desired.id !== "string") return [];
    const provided = input.packageRoots?.[install.desired.id] ?? await resolveProjectPackageRoot({
      install,
      projectDir: input.projectDir
    });
    if (provided) {
      await verifyPackageDigest({ install, packageRoot: provided });
      return [[install.desired.id, provided]];
    }
    const fetchInput = {
      install,
      cacheRoot: input.cacheRoot,
      execFile: input.execFile,
      tempRoot: input.tempRoot
    };
    const packageRoot = await fetchToCache(fetchInput);
    try {
      await verifyPackageDigest({ install, packageRoot });
    } catch {
      await fs7.rm(packageRoot, { recursive: true, force: true });
      const refetched = await fetchToCache(fetchInput);
      await verifyPackageDigest({ install, packageRoot: refetched });
      return [[install.desired.id, refetched]];
    }
    return [[install.desired.id, packageRoot]];
  }))).flat();
  return sorted2(Object.fromEntries(entries));
}
async function applyRuntimeAgentExtensionsNow(input, projectDir = projectDirDefault(), options = {}) {
  if (!input) return;
  const root = options.stateRoot ?? path9.join(projectDir, ".agent-extensions");
  await withAgentExtensionStateLock(root, async () => {
    const installs = input.installs;
    const enabledInstalls = installs.filter((item) => item.desired.enabled !== false);
    await writeFileAtomic(path9.join(root, "installed.json"), JSON.stringify({
      version: 1,
      installs: installs.map((item) => item.desired).sort(
        (a, b) => String(a.id ?? "").localeCompare(String(b.id ?? ""))
      )
    }, null, 2) + "\n");
    await writeFileAtomic(path9.join(root, "lock.json"), JSON.stringify({
      version: 1,
      packages: sorted2(Object.fromEntries(installs.flatMap(
        (item) => item.lock && typeof item.desired.id === "string" ? [[item.desired.id, item.lock]] : []
      )))
    }, null, 2) + "\n");
    await materializeAgentExtensionSnapshot({
      installs: installs.flatMap((item) => canonicalInstall(item) ?? []),
      packageRoots: await packageRoots({
        installs: enabledInstalls,
        projectDir,
        cacheRoot: path9.join(root, "cache"),
        execFile: options.execFile ?? execFileDefault,
        tempRoot: options.tempRoot ?? os.tmpdir(),
        ...options.packageRoots ? { packageRoots: options.packageRoots } : {}
      }),
      projectDir,
      stateRoot: root,
      homeDir: options.homeDir ?? os.homedir(),
      ...options.now !== void 0 ? { now: options.now } : {}
    });
  });
}
var applyQueue = Promise.resolve();
async function applyRuntimeAgentExtensions(input, projectDir = projectDirDefault(), options = {}) {
  const next = applyQueue.then(() => applyRuntimeAgentExtensionsNow(input, projectDir, options));
  applyQueue = next.catch(() => {
  });
  return next;
}
export {
  applyRuntimeAgentExtensions
};
