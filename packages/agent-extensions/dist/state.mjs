import {createRequire as __cr} from 'module';var require=__cr(import.meta.url);

// src/state.ts
import fs2 from "fs/promises";
import path2 from "path";

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

// src/state.ts
var AgentExtensionStateError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentExtensionStateError";
  }
};
function agentExtensionStateRoot(input) {
  if (input.scope === "project") {
    if (!input.projectDir) throw new AgentExtensionStateError("projectDir is required for project Agent Extension state");
    return path2.join(input.projectDir, ".agent-extensions");
  }
  if (input.scope === "workspace") {
    if (!input.workspaceId) throw new AgentExtensionStateError("workspaceId is required for workspace Agent Extension state");
    if (!input.dataRoot) throw new AgentExtensionStateError("dataRoot is required for workspace Agent Extension state");
    return path2.join(input.dataRoot, "agent-extensions", "workspaces", input.workspaceId);
  }
  if (!input.dataRoot) throw new AgentExtensionStateError("dataRoot is required for machine Agent Extension state");
  return path2.join(input.dataRoot, "agent-extensions");
}
function installedStatePath(input) {
  return path2.join(agentExtensionStateRoot(input), "installed.json");
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
  const raw = await readFileIfExists(file);
  if (raw === void 0) return { version: 1, installs: [] };
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new AgentExtensionStateError(
      `Agent Extension state file ${file} is not valid JSON; fix or remove it (treating it as empty would uninstall every recorded extension): ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return sortedState({
    version: 1,
    installs: Array.isArray(data.installs) ? data.installs : []
  });
}
async function writeDesiredExtensionState(file, state) {
  await fs2.mkdir(path2.dirname(file), { recursive: true, mode: 493 });
  await writeFileAtomic(file, encodeDesiredState(state));
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
