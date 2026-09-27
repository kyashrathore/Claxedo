import path from "node:path"

/**
 * The embedded OpenCode engine, the agent CLIs and their plugins resolve config,
 * data, cache and state from HOME and the XDG roots, not from the data directory
 * the app is given. A measured or tested app that inherited the operator's would
 * read their plugins (one fetches with a 5,000 ms timeout during startup) and
 * write into their harness directories.
 */
export function isolatedHomeEnv(home: string) {
  return {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
  }
}
