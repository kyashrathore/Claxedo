import { expect, test, vi } from "vitest"
import { localOnlyAuthAdapter } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../../authority/services"
import { SessionPeopleControlRoutes } from "./session-people-routes"

test.each(["POST", "DELETE"])("the former participant %s route is absent", async (method) => {
  const verifier = vi.fn()
  const services = { auth: localOnlyAuthAdapter() } as ControlPlaneServices
  const response = await SessionPeopleControlRoutes(services, { verifier }).request(
    "https://control.example.test/sessions/session-1/participants",
    {
      method,
      headers: { "content-type": "application/json", Authorization: "Bearer owner" },
      body: JSON.stringify({ workspaceId: "ws_1", participantActorId: "actor_other" }),
    },
  )
  expect(response.status).toBe(404)
  expect(verifier).not.toHaveBeenCalled()
})
