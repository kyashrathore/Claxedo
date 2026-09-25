import { configObject, onlyFields, resolveBindings, secretBindings, configStringArray, configStringRecord, configText, type SecretBindings } from "./bindings"
import { transportNotBuilt, type CustomHarnessProvider } from "./types"

export type PiRpcProviderConfig = {
  label: string
  command: string
  args?: string[]
  env?: Record<string, string>
  profileDir?: string
  secretBindings?: SecretBindings
}

export function createPiRpcProvider(): CustomHarnessProvider<PiRpcProviderConfig> {
  return {
    providerKey: "pi-rpc",
    validateConfig(input) {
      const row = configObject(input, "config")
      onlyFields(row, ["label", "command", "args", "env", "profileDir", "secretBindings"], "config")
      const env = configStringRecord(row.env, "env")
      const bindings = secretBindings(row.secretBindings, "process", env ?? {})
      return { label: configText(row.label, "label"), command: row.command === undefined ? "pi" : configText(row.command, "command"),
        ...(row.args !== undefined ? { args: configStringArray(row.args, "args")! } : {}),
        ...(env ? { env } : {}),
        ...(row.profileDir !== undefined ? { profileDir: configText(row.profileDir, "profileDir") } : {}),
        ...(bindings ? { secretBindings: bindings } : {}) }
    },
    immutableIdentity(config) { return JSON.stringify({ command: config.command, args: config.args ?? [], profileDir: config.profileDir ?? null }) },
    project(config) {
      return { label: config.label, readiness: "configured", capabilities: {
        abort: true, reconnect: false, replay: true, permissions: true, questions: true, todos: false,
        commands: false, fork: false, revert: false, unrevert: false, configOptions: true, subagents: false,
      } }
    },
    resolve({ descriptor, secrets }) {
      const config = descriptor.config
      return { config: { ...config, env: { ...config.env, ...resolveBindings(config.secretBindings, secrets) } } }
    },
    createTransport() { return transportNotBuilt("pi-rpc") },
  }
}
