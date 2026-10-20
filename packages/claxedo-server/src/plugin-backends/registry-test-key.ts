import { PLUGIN_REGISTRY_KEYS } from "@claxedo/plugin-api/release"

const TEST_KEY_ID = "test"

/**
 * The registry keys with the test key added, when
 * `CLAXEDO_APP_PLUGIN_REGISTRY_TEST_KEY` (a raw Ed25519 public key in base64)
 * is set. Only test compositions import this module; no deployed Worker may
 * reach it (`deployment-closures.test.ts`), so a deployment's environment
 * cannot make it trust another signer.
 */
export function registryKeysWithTestKey(env: Readonly<Record<string, unknown>>): Readonly<Record<string, string>> {
  const testKey = env.CLAXEDO_APP_PLUGIN_REGISTRY_TEST_KEY
  return typeof testKey === "string" && testKey ? { ...PLUGIN_REGISTRY_KEYS, [TEST_KEY_ID]: testKey } : PLUGIN_REGISTRY_KEYS
}
