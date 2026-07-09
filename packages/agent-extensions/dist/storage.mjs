import {createRequire as __cr} from 'module';var require=__cr(import.meta.url);

// src/materialization.ts
import path2 from "path";

// src/fs-safe.ts
var STATE_LOCK_STALE_MS = 10 * 60 * 1e3;

// src/state.ts
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

// src/materialization.ts
function materializedRecordPath(root) {
  return path2.join(root, "materialized.json");
}

// src/lock.ts
import path3 from "path";
function lockStatePath(root) {
  return path3.join(root, "lock.json");
}

// src/storage.ts
function agentExtensionFiles(input) {
  const root = agentExtensionStateRoot({
    scope: input.scope,
    ...input.projectDir ? { projectDir: input.projectDir } : {},
    ...input.workspaceId ? { workspaceId: input.workspaceId } : {},
    ...input.dataRoot ? { dataRoot: input.dataRoot } : {}
  });
  return {
    root,
    installed: installedStatePath({
      scope: input.scope,
      ...input.projectDir ? { projectDir: input.projectDir } : {},
      ...input.workspaceId ? { workspaceId: input.workspaceId } : {},
      ...input.dataRoot ? { dataRoot: input.dataRoot } : {}
    }),
    lock: lockStatePath(root),
    materialized: materializedRecordPath(root)
  };
}
function materializedAgentExtensionFiles(input) {
  return agentExtensionFiles(input);
}
function workspaceAgentExtensionFiles(input) {
  return agentExtensionFiles({
    scope: "workspace",
    workspaceId: input.workspaceId,
    ...input.dataRoot ? { dataRoot: input.dataRoot } : {}
  });
}
export {
  agentExtensionFiles,
  materializedAgentExtensionFiles,
  workspaceAgentExtensionFiles
};
