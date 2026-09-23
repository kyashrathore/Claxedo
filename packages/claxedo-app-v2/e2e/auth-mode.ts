export const e2eAuthModes = ["test-user", "local-unsigned"] as const

export type E2EAuthMode = (typeof e2eAuthModes)[number]

export function resolveE2EAuthMode(value = process.env.CLAXEDO_E2E_AUTH_MODE): E2EAuthMode {
  const mode = value ?? "test-user"
  if (!e2eAuthModes.includes(mode as E2EAuthMode)) {
    throw new Error(`CLAXEDO_E2E_AUTH_MODE="${mode}" is not known. Known modes: ${e2eAuthModes.join(", ")}.`)
  }
  return mode as E2EAuthMode
}

/** Preview settings tabs the core e2e suite exercises (mirrors CI e2e-build). */
const e2ePreviewSettingsFlags = {
  VITE_CLAXEDO_SETTINGS_CONNECTIONS_ENABLED: "true",
  VITE_CLAXEDO_SETTINGS_SANDBOX_PROVIDERS_ENABLED: "true",
} as const

/**
 * The complete build environment every e2e launcher of this app's vite config
 * hands the child process — `e2e/launch/build-e2e-app.ts` and
 * `e2e/launch/serve-e2e-app.ts` for the shared instance, the signed-web lanes'
 * production build and gateway (`e2e/helpers/web-signed-relay-harness.ts`),
 * and the desktop lane's forwarded-for proxy
 * (`e2e/helpers/desktop-signed-server.ts` through
 * `e2e/helpers/live-host-tunnel-relay-frontend-server.mjs`).
 *
 * One owner rather than one list per launcher: `vite.cloud.config.ts` calls
 * `resolveBrowserAuthBuildSelection`, which refuses to pick a browser auth
 * adapter implicitly and throws before the server can listen, so a launcher
 * that omits `VITE_CLAXEDO_AUTH_ADAPTER` does not serve a subtly different app
 * — it fails to start at all. Every launcher therefore reads the selection
 * from here instead of restating it.
 */
export function e2eAppViteEnvironment(mode: E2EAuthMode = resolveE2EAuthMode()): Record<string, string> {
  return {
    ...e2eAuthEnvironment(mode),
    // The e2e suite drives the Better Auth build on every surface.
    VITE_CLAXEDO_AUTH_ADAPTER: "better-auth",
    VITE_CLAXEDO_E2E: "1",
  }
}

function e2eAuthEnvironment(mode: E2EAuthMode): Record<string, string> {
  return {
    // The one difference between the two modes. Whether the app requires a
    // signed session is the SERVER's declaration, so a spec that wants the
    // signed posture mocks the bootstrap body rather than needing its own
    // build.
    VITE_CLAXEDO_DISABLE_TEST_AUTH_BYPASS: mode === "local-unsigned" ? "1" : "0",
    VITE_SANDBOX_ENABLED: "true",
    ...e2ePreviewSettingsFlags,
  }
}
