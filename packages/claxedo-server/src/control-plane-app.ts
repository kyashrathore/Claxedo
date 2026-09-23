import { Hono } from "hono"
import { ControlPlaneSessionRoutes } from "./session/routes/control-plane-session"
import { OrgTeamControlRoutes } from "./session/routes/org-team-routes"
import type { ControlPlaneServices } from "./authority/services"
import type {
  ControlPlaneTokenVerifier,
  ControlPlaneAuthConfig,
  SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
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
  return { app }
}
