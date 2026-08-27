export const e2eAuthModes = ["test-user", "local-unsigned"] as const

export type E2EAuthMode = (typeof e2eAuthModes)[number]

export function resolveE2EAuthMode(value = process.env.CLAXEDO_E2E_AUTH_MODE): E2EAuthMode {
  const mode = value ?? "test-user"
  if (!e2eAuthModes.includes(mode as E2EAuthMode)) {
    throw new Error(`CLAXEDO_E2E_AUTH_MODE="${mode}" is not known. Known modes: ${e2eAuthModes.join(", ")}.`)
  }
  return mode as E2EAuthMode
}

export function e2eAuthViteEnvironment(mode: E2EAuthMode): Record<string, string> {
  if (mode === "local-unsigned") {
    return {
      VITE_AUTH_ENABLED: "true",
      VITE_CLAXEDO_DISABLE_TEST_AUTH_BYPASS: "1",
      VITE_CLERK_PUBLISHABLE_KEY: "",
      VITE_SANDBOX_ENABLED: "true",
    }
  }
  return {
    VITE_AUTH_ENABLED: "true",
    VITE_CLAXEDO_DISABLE_TEST_AUTH_BYPASS: "0",
    VITE_SANDBOX_ENABLED: "true",
  }
}
