/**
 * A command a first-party plugin adds to the `claxedo` CLI. The CLI hands it
 * the account it is signed in to and its request path, so the plugin carries
 * no credential handling of its own.
 */
export type CliCommandContext = Readonly<{
  controlPlaneUrl(): string
  url(base: string, path: string): string
  /** Throws the service's own refusal message for a non-2xx answer. */
  requestJson(input: Readonly<{ url: string; method: string; token: string; body?: unknown }>): Promise<unknown>
  requireAccessToken(): Promise<string>
  env: Readonly<Record<string, string | undefined>>
}>

export type CliCommand = Readonly<{
  /** The first argument that selects it: `claxedo <name> …`. */
  name: string
  /** The lines `claxedo help` prints for it. */
  usage: string
  run(args: readonly string[], context: CliCommandContext): Promise<void>
}>
