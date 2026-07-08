/// <reference path="../../asset-imports.d.ts" />

import bashrc from "../templates/bashrc.template.sh?raw"
import codexLogWatcher from "../templates/codex-log-watcher.template.sh?raw"
import codexNotify from "../templates/codex-notify.template.sh?raw"
import codexWrapperExecLegacy from "../templates/codex-wrapper-exec-legacy.template.sh?raw"
import codexWrapperExec from "../templates/codex-wrapper-exec.template.sh?raw"
import copilotHook from "../templates/copilot-hook.template.sh?raw"
import cursorHook from "../templates/cursor-hook.template.sh?raw"
import geminiHook from "../templates/gemini-hook.template.sh?raw"
import notify from "../templates/notify.template.sh?raw"
import opencodePlugin from "../templates/opencode-plugin.template.txt?raw"
import wrapperCommon from "../templates/wrapper-common.template.sh?raw"
import zshenv from "../templates/zshenv.template.sh?raw"
import zshlogin from "../templates/zshlogin.template.sh?raw"
import zshprofile from "../templates/zshprofile.template.sh?raw"
import zshrc from "../templates/zshrc.template.sh?raw"

export const templates = {
  "bashrc.template.sh": bashrc,
  "codex-log-watcher.template.sh": codexLogWatcher,
  "codex-notify.template.sh": codexNotify,
  "codex-wrapper-exec-legacy.template.sh": codexWrapperExecLegacy,
  "codex-wrapper-exec.template.sh": codexWrapperExec,
  "copilot-hook.template.sh": copilotHook,
  "cursor-hook.template.sh": cursorHook,
  "gemini-hook.template.sh": geminiHook,
  "notify.template.sh": notify,
  "opencode-plugin.template.txt": opencodePlugin,
  "wrapper-common.template.sh": wrapperCommon,
  "zshenv.template.sh": zshenv,
  "zshlogin.template.sh": zshlogin,
  "zshprofile.template.sh": zshprofile,
  "zshrc.template.sh": zshrc,
} as const

export type TemplateName = keyof typeof templates
