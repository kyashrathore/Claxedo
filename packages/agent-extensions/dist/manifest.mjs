import {createRequire as __cr} from 'module';var require=__cr(import.meta.url);

// src/manifest.ts
import fs from "fs/promises";
import path from "path";

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

// src/manifest.ts
var AgentExtensionManifestError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentExtensionManifestError";
  }
};
var marketplaceManifests = [
  { runner: "cursor", path: ".cursor-plugin/marketplace.json" },
  { runner: "codex", path: ".agents/plugins/marketplace.json" },
  { runner: "claude", path: ".claude-plugin/marketplace.json" }
];
var pluginManifests = [
  { runner: "claude", path: ".claude-plugin/plugin.json" },
  { runner: "codex", path: ".codex-plugin/plugin.json" },
  { runner: "cursor", path: ".cursor-plugin/plugin.json" }
];
var mcpConfigs = ["mcp.json", ".vscode/mcp.json"];
async function exists(file) {
  return fs.stat(file).then((item) => item.isFile()).catch(() => false);
}
async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    throw new AgentExtensionManifestError(`${path.basename(file)} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function manifestName(manifest, file) {
  if (typeof manifest.name === "string" && manifest.name.trim()) return manifest.name.trim();
  throw new AgentExtensionManifestError(`${file} must include a non-empty name`);
}
function rawCatalogEntries(manifest) {
  if (Array.isArray(manifest.packages)) return manifest.packages;
  if (Array.isArray(manifest.plugins)) return manifest.plugins;
  if (Array.isArray(manifest.entries)) return manifest.entries;
  return [];
}
function catalogEntryPath(input) {
  try {
    return safeRelativePath(input, "catalog entry path");
  } catch (err) {
    if (err instanceof AgentExtensionSourceError) throw new AgentExtensionManifestError(err.message);
    throw err;
  }
}
async function catalogEntries(root, manifest) {
  return await Promise.all(rawCatalogEntries(manifest).map(async (item) => {
    if (!item || typeof item !== "object") throw new AgentExtensionManifestError("Catalog entries must be objects");
    const value = item;
    const rawPath = typeof value.path === "string" ? value.path : typeof value.package_path === "string" ? value.package_path : void 0;
    if (!rawPath) throw new AgentExtensionManifestError("Catalog entries must include a local path");
    if (/^(?:https?:|git\+|npm:|file:)/.test(rawPath)) throw new AgentExtensionManifestError("Catalog entries must stay in the same GitHub repo");
    const entryPath = catalogEntryPath(rawPath);
    if (!await fs.stat(path.join(root, entryPath)).then((stat) => stat.isDirectory()).catch(() => false)) {
      throw new AgentExtensionManifestError(`Catalog entry ${entryPath} must point to a non-empty local directory`);
    }
    if ((await fs.readdir(path.join(root, entryPath))).length === 0) {
      throw new AgentExtensionManifestError(`Catalog entry ${entryPath} must point to a non-empty local directory`);
    }
    return {
      name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : path.basename(entryPath),
      path: entryPath
    };
  }));
}
async function discoverMarketplace(root) {
  return (await Promise.all(marketplaceManifests.map(async (item) => ({
    ...item,
    exists: await exists(path.join(root, item.path))
  })))).filter((item) => item.exists);
}
async function discoverPlugins(root) {
  return (await Promise.all(pluginManifests.map(async (item) => ({
    ...item,
    exists: await exists(path.join(root, item.path))
  })))).filter((item) => item.exists);
}
async function discoverAgentExtensionPackage(root) {
  const marketplaces = await discoverMarketplace(root);
  const plugins = await discoverPlugins(root);
  if (marketplaces.length > 0 && plugins.length > 0) {
    throw new AgentExtensionManifestError("Agent Extension root is ambiguous: marketplace and plugin manifests both exist");
  }
  if (marketplaces.length > 0) {
    const selected = marketplaces[0];
    const manifest = await readJson(path.join(root, selected.path));
    return {
      type: "marketplace",
      runner: selected.runner,
      manifest_path: selected.path,
      manifest,
      entries: await catalogEntries(root, manifest)
    };
  }
  if (plugins.length > 0) {
    const manifests = await Promise.all(plugins.map(async (item) => ({
      runner: item.runner,
      path: item.path,
      manifest: await readJson(path.join(root, item.path))
    })));
    const names = new Set(manifests.map((item) => manifestName(item.manifest, item.path)));
    if (names.size !== 1) throw new AgentExtensionManifestError("Plugin manifests in one package root must use the same name");
    return { type: "native-plugin", name: [...names][0], manifests };
  }
  if (await exists(path.join(root, "SKILL.md"))) {
    return { type: "standalone-skill", name: path.basename(root), skill_path: "SKILL.md" };
  }
  const mcp = (await Promise.all(mcpConfigs.map(async (item) => ({
    path: item,
    exists: await exists(path.join(root, item))
  })))).find((item) => item.exists);
  if (mcp) {
    return {
      type: "standalone-mcp",
      name: path.basename(root),
      config_path: mcp.path,
      config: await readJson(path.join(root, mcp.path))
    };
  }
  throw new AgentExtensionManifestError("Unsupported Agent Extension package shape");
}
export {
  AgentExtensionManifestError,
  discoverAgentExtensionPackage
};
