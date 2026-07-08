import {createRequire as __cr} from 'module';var require=__cr(import.meta.url);

// src/state.ts
import fs from "fs/promises";
import path from "path";
var AgentExtensionStateError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentExtensionStateError";
  }
};
function agentExtensionStateRoot(input) {
  if (input.scope === "project") {
    if (!input.projectDir) throw new AgentExtensionStateError("projectDir is required for project Agent Extension state");
    return path.join(input.projectDir, ".agent-extensions");
  }
  if (input.scope === "workspace") {
    if (!input.workspaceId) throw new AgentExtensionStateError("workspaceId is required for workspace Agent Extension state");
    if (!input.dataRoot) throw new AgentExtensionStateError("dataRoot is required for workspace Agent Extension state");
    return path.join(input.dataRoot, "agent-extensions", "workspaces", input.workspaceId);
  }
  if (!input.dataRoot) throw new AgentExtensionStateError("dataRoot is required for machine Agent Extension state");
  return path.join(input.dataRoot, "agent-extensions");
}
function installedStatePath(input) {
  return path.join(agentExtensionStateRoot(input), "installed.json");
}
function sortedInstall(input) {
  return {
    ...input,
    targets: [...input.targets].sort()
  };
}
function sortedState(input) {
  return {
    version: 1,
    installs: input.installs.map(sortedInstall).sort((a, b) => a.id.localeCompare(b.id))
  };
}
function encodeDesiredState(input) {
  return JSON.stringify(sortedState(input), null, 2) + "\n";
}
async function readDesiredExtensionState(file) {
  const data = await fs.readFile(file, "utf8").then((raw) => JSON.parse(raw)).catch(() => null);
  if (!data) return { version: 1, installs: [] };
  return sortedState({
    version: 1,
    installs: Array.isArray(data.installs) ? data.installs : []
  });
}
async function writeDesiredExtensionState(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 493 });
  await fs.writeFile(file, encodeDesiredState(state), { mode: 420 });
}
async function upsertDesiredExtensionInstall(file, install) {
  const current = await readDesiredExtensionState(file);
  await writeDesiredExtensionState(file, {
    version: 1,
    installs: [...current.installs.filter((item) => item.id !== install.id), install]
  });
}
async function removeDesiredExtensionInstall(file, id) {
  const current = await readDesiredExtensionState(file);
  await writeDesiredExtensionState(file, {
    version: 1,
    installs: current.installs.filter((item) => item.id !== id)
  });
}
async function setDesiredExtensionEnabled(file, id, enabled, updatedAt = Date.now()) {
  const current = await readDesiredExtensionState(file);
  await writeDesiredExtensionState(file, {
    version: 1,
    installs: current.installs.map((item) => item.id === id ? {
      ...item,
      enabled,
      updated_at: updatedAt
    } : item)
  });
}
export {
  AgentExtensionStateError,
  agentExtensionStateRoot,
  encodeDesiredState,
  installedStatePath,
  readDesiredExtensionState,
  removeDesiredExtensionInstall,
  setDesiredExtensionEnabled,
  upsertDesiredExtensionInstall,
  writeDesiredExtensionState
};
