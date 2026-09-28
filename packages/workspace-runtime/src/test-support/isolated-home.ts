import "./home/isolated-home.mjs"

/** The runtime's data roots derive from the isolated home only when no inherited override names one. */
for (const key of [
  "WORKSPACE_RUNTIME_DATA_DIR",
  "WORKSPACE_RUNTIME_STATE_DIR",
  "WORKSPACE_RUNTIME_STORE_DIR",
  "WORKSPACE_RUNTIME_PTY_HISTORY_DIR",
  "WORKSPACE_RUNTIME_WORKSPACES_DIR",
]) delete process.env[key]
