import { dockerSandboxDriverEnabled, sandboxDriverIds, type SandboxDriverEnv } from "@claxedo/sandbox-contract"
import { loadUserConfig, sandboxDriverConfig, saveUserConfig, setSandboxDriverConfig } from "@claxedo/server-core/agent-config/index"
import type { SandboxDriverKeys } from "@claxedo/server-core/credentials/routes/sandbox-driver-keys"

/**
 * This machine's sandbox provider keys: each person's own, changed only by the
 * operator sitting at the machine, with the default driver kept in the
 * machine's agent config.
 */
export function localSandboxDriverKeys(env: SandboxDriverEnv): SandboxDriverKeys {
  return {
    drivers: sandboxDriverIds.filter((id) => id !== "docker" || dockerSandboxDriverEnabled(env)),
    owner: "person",
    canManage: async (_request, context) => context.localOperator,
    chosenDriver: async () => sandboxDriverConfig(await loadUserConfig()).default_driver,
    chooseDriver: async (_context, driver) => {
      const config = await loadUserConfig()
      const { auth } = sandboxDriverConfig(config)
      setSandboxDriverConfig(config, { ...(auth ? { auth } : {}), ...(driver ? { default_driver: driver } : {}) })
      await saveUserConfig(config)
    },
  }
}
