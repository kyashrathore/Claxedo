/// <reference path="../../asset-imports.d.ts" />

import bashrc from "../templates/bashrc.template.sh?raw"
import projectFile from "../templates/project-file.template.sh?raw"
import notify from "../templates/notify.template.sh?raw"
import notifyCmd from "../templates/notify.cmd.template.txt?raw"
import wrapperCommon from "../templates/wrapper-common.template.sh?raw"
import wrapperCommonCmd from "../templates/wrapper-common.cmd.template.txt?raw"
import zshenv from "../templates/zshenv.template.sh?raw"
import zshlogin from "../templates/zshlogin.template.sh?raw"
import zshprofile from "../templates/zshprofile.template.sh?raw"
import zshrc from "../templates/zshrc.template.sh?raw"

export const templates = {
  "bashrc.template.sh": bashrc,
  "notify.template.sh": notify,
  "notify.cmd.template.txt": notifyCmd,
  "project-file.template.sh": projectFile,
  "wrapper-common.template.sh": wrapperCommon,
  "wrapper-common.cmd.template.txt": wrapperCommonCmd,
  "zshenv.template.sh": zshenv,
  "zshlogin.template.sh": zshlogin,
  "zshprofile.template.sh": zshprofile,
  "zshrc.template.sh": zshrc,
} as const

export type TemplateName = keyof typeof templates
