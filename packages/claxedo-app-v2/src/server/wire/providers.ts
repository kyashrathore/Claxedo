import { ServerError } from "../errors"

export const PROVIDERS_PATH = "/api/claxedo/agent-config/providers"

export function connectedProvidersFromWire(body: unknown): readonly string[] {
  const connected = body && typeof body === "object" ? (body as { connected?: unknown }).connected : undefined
  if (!Array.isArray(connected)) throw new ServerError({ class: "internal", message: "The provider catalog answered without its connected providers" })
  return connected.filter((item): item is string => typeof item === "string")
}
