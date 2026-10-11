import * as fs from "fs"
import * as path from "path"
import { CLAXEDO_DIR, FIND_REAL_BINARY, WRAPPER_MARKER, WRAPPER_NAME, WRAPPERS_JSON } from "./constants"
import { batchText, cmdQuote, loadTemplate, shellQuote, writeIfChanged } from "./utils"
import { asArrayOrUndefined, asRecord } from "@claxedo/helpers/guards"
import type { StatusHookTemplate } from "@claxedo/plugin-api"
import { wrappedCommands, type HookPlatform } from "./platform"
import { hookArguments, hookVariables, projectHookContent, renderHookText } from "./render"

export function buildWrapperScript(binaryName: string, execBlock: string, platform: HookPlatform): string {
  if (platform === "windows")
    return batchText(
      loadTemplate("wrapper-common.cmd.template.txt", {
        MARKER: WRAPPER_MARKER,
        BINARY_NAME: binaryName,
        EXEC_BLOCK: execBlock,
      }),
    )
  return loadTemplate("wrapper-common.template.sh", {
    MARKER: WRAPPER_MARKER,
    FIND_REAL_BINARY,
    BINARY_NAME: binaryName,
    EXEC_BLOCK: execBlock,
  })
}

export function generateGenericWrapper(binaryName: string, notifyPath: string, platform: HookPlatform): string {
  if (platform === "windows") {
    const notify = cmdQuote(notifyPath)
    return buildWrapperScript(
      binaryName,
      `if defined CLAXEDO_TAB_ID (echo {"hook_event_name":"Busy"}| ${notify} >nul 2>&1)

call "%REAL_BIN%" %*
set "CLAXEDO_EXIT=%ERRORLEVEL%"

set "CLAXEDO_EVENT=Idle"
if not "%CLAXEDO_EXIT%"=="0" set "CLAXEDO_EVENT=Error"
if defined CLAXEDO_TAB_ID (echo {"hook_event_name":"%CLAXEDO_EVENT%"}| ${notify} >nul 2>&1)

exit /b %CLAXEDO_EXIT%`,
      platform,
    )
  }
  return buildWrapperScript(
    binaryName,
    `if [ -n "\${CLAXEDO_TAB_ID:-}" ]; then
  echo '{"hook_event_name":"Busy"}' | ${shellQuote(notifyPath)} 2>/dev/null &
fi

"$REAL_BIN" "$@"
EXIT_CODE=$?

if [ -n "\${CLAXEDO_TAB_ID:-}" ]; then
  if [ $EXIT_CODE -ne 0 ]; then
    echo '{"hook_event_name":"Error"}' | ${shellQuote(notifyPath)} 2>/dev/null &
  else
    echo '{"hook_event_name":"Idle"}' | ${shellQuote(notifyPath)} 2>/dev/null &
  fi
fi

exit $EXIT_CODE`,
    platform,
  )
}

export const normalizeWrappers = (items: string[]) => {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of items) {
    const next = value.trim().toLowerCase()
    if (!WRAPPER_NAME.test(next)) continue
    if (seen.has(next)) continue
    seen.add(next)
    result.push(next)
    if (result.length >= 48) break
  }
  return result
}

const wrappersPath = (root = CLAXEDO_DIR) => path.join(root, WRAPPERS_JSON)

export const loadCustomWrappers = async (root = CLAXEDO_DIR) => {
  try {
    const raw = await fs.promises.readFile(wrappersPath(root), "utf-8")
    const custom = asArrayOrUndefined(asRecord(JSON.parse(raw))?.custom) ?? []
    return normalizeWrappers(custom.filter((item): item is string => typeof item === "string"))
  } catch {
    return []
  }
}

export const saveCustomWrappers = async (custom: string[], root = CLAXEDO_DIR) => {
  const next = normalizeWrappers(custom)
  await fs.promises.mkdir(root, { recursive: true, mode: 0o755 })
  await writeIfChanged(wrappersPath(root), JSON.stringify({ custom: next }, null, 2) + "\n", 0o644, true)
  return next
}

export async function readWrapperInventory(
  root: string,
  templates: readonly StatusHookTemplate[],
  generic: readonly string[],
) {
  const custom = await loadCustomWrappers(root)
  const defaults = normalizeWrappers([...generic])
  const all = normalizeWrappers([...defaults, ...custom, ...templates.flatMap(wrappedCommands)])
  return { defaults, custom, all }
}

/** `template` is the installation `platform` uses, as `installedTemplates` returns it. */
export function generateTemplateWrapper(
  template: StatusHookTemplate,
  notify: string,
  platform: HookPlatform,
  command = template.command,
): string {
  const args = hookArguments(template, notify, platform)
  const windows = platform === "windows"
  const variables = {
    ...Object.fromEntries(args.map((arg, index) => [`arg${index}`, arg])),
    ...hookVariables(template, notify, platform),
    args: args.map(windows ? cmdQuote : shellQuote).join(" "),
    ...(template.install.type === "project-file"
      ? { projectInstall: generateProjectInstallation(template, notify, platform) }
      : {}),
  }
  if (template.wrapper) return buildWrapperScript(command, renderHookText(template.wrapper, variables), platform)
  if (windows) return buildWrapperScript(command, `call "%REAL_BIN%" ${variables.args ? variables.args + " " : ""}%*`, platform)
  return buildWrapperScript(
    command,
    `${variables.projectInstall ? variables.projectInstall + "\n\n" : ""}exec "$REAL_BIN" ${variables.args ? variables.args + " " : ""}"$@"`,
    platform,
  )
}

function generateProjectInstallation(template: StatusHookTemplate, notify: string, platform: HookPlatform): string {
  if (template.install.type !== "project-file") throw new Error("Template does not install a project file")
  if (platform === "windows") throw new Error("Project-file installs have no Windows wrapper")
  const install = template.install
  const quotedDirectory = JSON.stringify(path.dirname(install.path)).replaceAll("$", "\\$").replaceAll("`", "\\`")
  return renderHookText(loadTemplate("project-file.template.sh", {}), {
    prefix: template.command.toUpperCase().replace(/[^A-Z0-9_]/g, "_"),
    hookScript: path.join(path.dirname(notify), install.hookFile),
    projectDir: quotedDirectory,
    projectFile: path.basename(install.path),
    projectPath: install.path,
    project: projectHookContent(template, notify, platform),
  }).trimEnd()
}
