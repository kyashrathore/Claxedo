import {createRequire as __cr} from 'module';var require=__cr(import.meta.url);

// src/materializers/mcp.ts
import fs from "fs/promises";
import path from "path";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";

// src/materialization.ts
var AgentExtensionMaterializationError = class extends Error {
  constructor(message, code = "agent_extension_materialization_error", details = {}) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "AgentExtensionMaterializationError";
  }
};

// src/materializers/mcp.ts
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
      return path.join(input.projectDir, ".cursor", "mcp.json");
    }
    if (!input.homeDir) throw new Error("homeDir is required for machine Cursor MCP materialization");
    return path.join(input.homeDir, ".cursor", "mcp.json");
  }
  if (input.runner === "claude") {
    if (input.scope === "project") {
      if (!input.projectDir) throw new Error("projectDir is required for project Claude MCP materialization");
      return path.join(input.projectDir, ".mcp.json");
    }
    if (!input.homeDir) throw new Error("homeDir is required for machine Claude MCP materialization");
    return path.join(input.homeDir, ".claude.json");
  }
  if (input.runner === "codex") {
    if (input.scope === "project") {
      if (!input.projectDir) throw new Error("projectDir is required for project Codex MCP materialization");
      return path.join(input.projectDir, ".codex", "config.toml");
    }
    if (!input.homeDir) throw new Error("homeDir is required for machine Codex MCP materialization");
    return path.join(input.homeDir, ".codex", "config.toml");
  }
  if (input.runner === "opencode") {
    if (input.scope === "project") {
      if (!input.projectDir) throw new Error("projectDir is required for project OpenCode MCP materialization");
      return path.join(input.projectDir, ".opencode", "opencode.jsonc");
    }
    if (!input.homeDir) throw new Error("homeDir is required for machine OpenCode MCP materialization");
    return path.join(input.homeDir, ".config", "opencode", "opencode.jsonc");
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
  return fs.readFile(file, "utf8").catch(() => "");
}
async function readJson(file) {
  return fs.readFile(file, "utf8").then(readJsonFromText).catch(() => ({}));
}
function readJsonFromText(raw) {
  return asRecord(parseJsonc(raw));
}
async function writeJson(file, input) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 493 });
  await fs.writeFile(file, JSON.stringify(input, null, 2) + "\n", { mode: 420 });
}
async function removeStandaloneMcpEntries(input) {
  if (input.file.endsWith(".toml")) {
    const raw = await readText(input.file);
    const names = new Set(input.names);
    const sections = codexMcpSections(raw).filter((section) => names.has(section.name));
    const next2 = [...sections].reverse().reduce((text, section) => `${text.slice(0, section.start)}${text.slice(section.end)}`, raw);
    await fs.writeFile(input.file, next2.replace(/\n{3,}/g, "\n\n"), { mode: 420 });
    return;
  }
  const root = await readJson(input.file);
  const key = input.file.endsWith("opencode.jsonc") || input.file.endsWith("opencode.json") ? "mcp" : "mcpServers";
  const current = asRecord(root[key]);
  for (const name of input.names) {
    delete current[name];
  }
  const next = { ...root };
  if (Object.keys(current).length > 0) next[key] = sortedObject(current);
  else delete next[key];
  if (Object.keys(next).length === 0) {
    await fs.rm(input.file, { force: true });
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
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 493 });
    await fs.writeFile(target, `${prefix}${Object.entries(nextSections).map(([name, cfg]) => codexMcpSection(name, cfg)).join("\n")}`, { mode: 420 });
    return mcpComponents({ runner: input.runner, target, names: Object.keys(nextSections) });
  }
  if (input.runner === "opencode") {
    const raw = await readText(target);
    const root2 = raw.trim() ? readJsonFromText(raw) : {};
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
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 493 });
    await fs.writeFile(target, `${next.trimEnd()}
`, { mode: 420 });
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
export {
  materializeStandaloneMcp,
  mcpTargetPath,
  normalizeStandaloneMcpConfig,
  removeStandaloneMcpEntries
};
