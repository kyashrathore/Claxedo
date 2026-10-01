import { defaultStatusHooks } from "../status-hooks"
import { hookArguments, hookArtifact, projectHookContent } from "../agent-hooks/core/render"
import { generateTemplateWrapper } from "../agent-hooks/core/wrappers"
import { generateNotifyScript } from "../agent-hooks/core/hooks"
import { providerLifecycle } from "../agent-hooks/provider-lifecycle"

export const template = (command: string) => defaultStatusHooks.find((item) => item.command === command)!
export const wrapper = (command: string, notify: string) => generateTemplateWrapper(template(command), notify)
export const artifact = (command: string, file: string, notify: string) => hookArtifact(template(command), file, notify)
export const argumentsFor = (command: string, notify: string) => hookArguments(template(command), notify)
export const projectContent = (command: string, notify: string) => projectHookContent(template(command), notify)
export const textInstall = (command: string) =>
  template(command).install.type === "config-merge" ? (template(command).install as { entries: string }).entries : ""
export const notifyScript = (port: number) => generateNotifyScript(port, defaultStatusHooks)
export const lifecycle = (input: Record<string, unknown>) => providerLifecycle(input, defaultStatusHooks)
