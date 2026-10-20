import { mkdir } from "node:fs/promises"
import path from "node:path"

export type StatePaths = {
  home: string
  xdgConfig: string
  xdgCache: string
  xdgData: string
  xdgState: string
  data: string
  profile: string
  appLog: string
  daemonLog: string
}

export function statePaths(stateRoot: string): StatePaths {
  return {
    home: path.join(stateRoot, "home"),
    xdgConfig: path.join(stateRoot, "xdg", "config"),
    xdgCache: path.join(stateRoot, "xdg", "cache"),
    xdgData: path.join(stateRoot, "xdg", "data"),
    xdgState: path.join(stateRoot, "xdg", "state"),
    data: path.join(stateRoot, "data"),
    profile: path.join(stateRoot, "profile"),
    appLog: path.join(stateRoot, "app.log"),
    daemonLog: path.join(stateRoot, "daemon.log"),
  }
}

const INHERITED = ["PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "USER", "LOGNAME", "SHELL", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"]

export function isolatedEnvironment(stateRoot: string): Record<string, string> {
  const paths = statePaths(stateRoot)
  const inherited = INHERITED.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]] as const]))
  return {
    ...Object.fromEntries(inherited),
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.xdgConfig,
    XDG_CACHE_HOME: paths.xdgCache,
    XDG_DATA_HOME: paths.xdgData,
    XDG_STATE_HOME: paths.xdgState,
    CLAXEDO_DATA_DIR: paths.data,
    CLAXEDO_DESKTOP_USER_DATA_DIR: paths.profile,
  }
}

export async function createStateRoot(stateRoot: string) {
  const paths = statePaths(stateRoot)
  const directories = [paths.home, paths.xdgConfig, paths.xdgCache, paths.xdgData, paths.xdgState, paths.data, paths.profile]
  await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })))
  return paths
}
