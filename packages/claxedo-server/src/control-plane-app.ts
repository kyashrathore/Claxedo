import { Hono } from "hono"
import { ControlPlaneSessionRoutes } from "./session/routes/control-plane-session"
import { OrgTeamControlRoutes } from "./session/routes/org-team-routes"
import type { ControlPlaneServices } from "./authority/services"
import type {
  ControlPlaneTokenVerifier,
  ControlPlaneAuthConfig,
  SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import type { UsageLedger } from "./platform/telemetry/product/metering"
import { UsageRoutes } from "@claxedo/server-core/usage/routes"
import type { SessionShareChangedSink } from "./session/session-people-contract"
import type { MachineSessionCreate } from "./session/machine-dispatch"

export {
  ControlPlaneAuthError,
  localOnlyAuthAdapter,
  type ControlPlaneAuthAdapter,
} from "@claxedo/server-core/platform/auth/auth"
export { createControlPlaneServices } from "./authority/services"
export type { ControlPlaneServices } from "./authority/services"

export type ControlPlaneAppOptions = {
  authConfig?: ControlPlaneAuthConfig
  verifier?: ControlPlaneTokenVerifier
  beforeLocalSessionList?: () => Promise<void>
  usageLedger?: UsageLedger
  mountPublicUsageRoute?: boolean
  sessionShareChangedSink?: SessionShareChangedSink
  createMachineSession?: (input: MachineSessionCreate, auth?: SignedControlPlaneAuth) => Promise<{ id: string }>
}

export function createControlPlaneApp(services: ControlPlaneServices, options: ControlPlaneAppOptions = {}) {
  const app = new Hono()
  app.route(
    "/api/control",
    ControlPlaneSessionRoutes(services, {
      ...(options.authConfig ? { authConfig: options.authConfig } : {}),
      ...(options.verifier ? { verifier: options.verifier } : {}),
      ...(options.beforeLocalSessionList ? { beforeLocalList: options.beforeLocalSessionList } : {}),
      ...(options.sessionShareChangedSink ? { sessionShareChangedSink: options.sessionShareChangedSink } : {}),
      createMachineSession: options.createMachineSession,
    }),
  )
  app.route(
    "/api/control",
    OrgTeamControlRoutes(services, {
      ...(options.authConfig ? { authConfig: options.authConfig } : {}),
      ...(options.verifier ? { verifier: options.verifier } : {}),
    }),
  )
  if (options.usageLedger) {
    const usageOptions = {
      ledger: options.usageLedger,
      ...(options.authConfig ? { authConfig: options.authConfig } : {}),
      ...(options.verifier ? { verifier: options.verifier } : {}),
      telemetry: services.telemetry,
    }
    app.route("/api/control/usage", UsageRoutes(usageOptions))
    if (options.mountPublicUsageRoute !== false) app.route("/api/claxedo/usage", UsageRoutes(usageOptions))
  }
  return { app }
}
