import type { Message } from "esbuild"

export type PluginBuildFailure = "manifest" | "entry" | "bundle"

export type PluginCheckStage = PluginBuildFailure | "typecheck"

export type PluginDiagnostic = Readonly<{
  stage: PluginCheckStage
  file?: string
  line?: number
  column?: number
  code?: string
  message: string
}>

export function formatPluginDiagnostic(diagnostic: PluginDiagnostic): string {
  const where = [diagnostic.file, diagnostic.line, diagnostic.column].filter((part) => part !== undefined).join(":")
  const code = diagnostic.code ? `${diagnostic.code}: ` : ""
  return where ? `${where}: ${code}${diagnostic.message}` : `${code}${diagnostic.message}`
}

export class PluginBuildError extends Error {
  readonly failure: PluginBuildFailure
  readonly diagnostics: readonly PluginDiagnostic[]
  readonly messages: readonly string[]

  constructor(failure: PluginBuildFailure, diagnostics: readonly Omit<PluginDiagnostic, "stage">[]) {
    const staged = diagnostics.map((diagnostic) => ({ ...diagnostic, stage: failure }))
    const messages = staged.map(formatPluginDiagnostic)
    super(messages.join("\n"))
    this.name = "PluginBuildError"
    this.failure = failure
    this.diagnostics = staged
    this.messages = messages
  }
}

function bundleDiagnostic(message: Message) {
  const { location } = message
  return {
    ...(location ? { file: location.file, line: location.line, column: location.column + 1 } : {}),
    message: message.text,
  }
}

export function bundleFailure(error: unknown): PluginBuildError | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const errors = (error as { errors?: unknown }).errors
  return Array.isArray(errors) ? new PluginBuildError("bundle", (errors as Message[]).map(bundleDiagnostic)) : undefined
}
