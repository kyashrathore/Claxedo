export type PluginBuildFailure = "manifest" | "entry" | "bundle"

export class PluginBuildError extends Error {
  readonly failure: PluginBuildFailure
  readonly messages: readonly string[]

  constructor(failure: PluginBuildFailure, messages: readonly string[]) {
    super(messages.join("\n"))
    this.name = "PluginBuildError"
    this.failure = failure
    this.messages = messages
  }
}
