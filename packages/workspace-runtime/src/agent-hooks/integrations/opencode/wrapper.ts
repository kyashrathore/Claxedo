import { buildWrapperScript } from "../../core/wrappers"

export function generateOpenCodeWrapper(configDir: string): string {
  return buildWrapperScript("opencode", `export OPENCODE_CONFIG_DIR="${configDir}"\nexec "$REAL_BIN" "$@"`)
}
