import path from "node:path"
import type { StatusHookTemplate } from "@claxedo/plugin-api"
import { shellQuote } from "./utils"

export function renderHookText(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{([^{}]+)\}\}/g, (_, expression: string) => {
    const [name, ...transforms] = expression.split("|")
    let value = variables[name]
    if (value === undefined) throw new Error(`Unknown status hook variable: ${name}`)
    for (const transform of transforms) {
      if (transform === "sh") value = shellQuote(value)
      else if (transform === "json") value = JSON.stringify(value)
      else throw new Error(`Unknown status hook transform: ${transform}`)
    }
    return value
  })
}

export function renderHookValue(value: unknown, variables: Record<string, string>): unknown {
  if (typeof value === "string") return renderHookText(value, variables)
  if (Array.isArray(value)) return value.map((item) => renderHookValue(item, variables))
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderHookValue(item, variables)]))
  return value
}

export function hookVariables(template: StatusHookTemplate, notify: string) {
  return {
    ...Object.fromEntries(
      (template.artifacts ?? []).map((artifact) => [artifact.file, path.join(path.dirname(notify), artifact.file)]),
    ),
    notify,
    hooks: path.dirname(notify),
    notifyCommand: `${shellQuote(notify)} --harness=${template.provider}`,
  }
}

export function hookArguments(template: StatusHookTemplate, notify: string): string[] {
  return template.install.type === "wrapper-flags"
    ? template.install.args.map((arg) => renderHookText(arg, hookVariables(template, notify)))
    : []
}

export function hookArtifact(template: StatusHookTemplate, file: string, notify: string) {
  const artifact = template.artifacts?.find((entry) => entry.file === file)
  if (!artifact) throw new Error(`Undeclared status hook artifact: ${file}`)
  const variables = hookVariables(template, notify)
  return file.endsWith(".json")
    ? JSON.stringify(renderHookValue(JSON.parse(artifact.content), variables), null, 2) + "\n"
    : renderHookText(artifact.content, variables)
}

export function projectHookContent(template: StatusHookTemplate, notify: string) {
  if (template.install.type !== "project-file") throw new Error("Template does not install a project file")
  return JSON.stringify(renderHookValue(template.install.entries, hookVariables(template, notify)), null, 2) + "\n"
}
