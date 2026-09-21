import path from "path"

export function shell(input: string) {
  return `'${input.replace(/'/g, `'"'"'`)}'`
}

export function file(...parts: string[]) {
  return shell(path.posix.join(...parts))
}

/**
 * Env rendered as a sourceable script (one `export KEY='value'` line per entry)
 * so drivers can deliver it through a provider file channel and have the
 * workload source it, instead of serializing values into exec argv where
 * command logs and process listings expose them. Names that `export` cannot
 * carry are refused outright — silently dropping them would boot the runtime
 * missing configuration.
 */
export function envFile(input: Record<string, string>) {
  return (
    Object.entries(input)
      .map(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          throw new Error(`environment variable ${JSON.stringify(key)} cannot be exported through an env file`)
        }
        return `export ${key}=${shell(value)}`
      })
      .join("\n") + "\n"
  )
}
