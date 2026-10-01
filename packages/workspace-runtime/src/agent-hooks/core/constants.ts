import * as path from "path"
import { dataDir } from "../../paths"

export const CLAXEDO_DIR = dataDir()
export const BIN_DIR = path.join(CLAXEDO_DIR, "bin")
export const HOOKS_DIR = path.join(CLAXEDO_DIR, "hooks")
export const SHELL_DIR = path.join(CLAXEDO_DIR, "shell")
export const BASH_DIR = path.join(CLAXEDO_DIR, "bash")

export const WRAPPER_MARKER = "# Claxedo agent-wrapper v1"
export const NOTIFY_MARKER = "# Claxedo agent notification hook v1"
export const SHELL_MARKER = "# Claxedo shell integration v1"

export const NOTIFY_SCRIPT = "notify.sh"
export const WRAPPERS_JSON = "wrappers.json"

export const WRAPPER_NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/

export const FIND_REAL_BINARY = `
find_real_binary() {
  local name="$1"
  local IFS=':'
  for dir in $PATH; do
    [ -z "$dir" ] && continue
    case "$dir" in
      "${BIN_DIR}"|"$HOME/.workspace-runtime/bin") continue ;;
    esac
    if [ -x "$dir/$name" ] && [ ! -d "$dir/$name" ]; then
      printf "%s\\n" "$dir/$name"
      return 0
    fi
  done
  return 1
}
`
