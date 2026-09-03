import type { FirstPartyServiceDescriptor, FirstPartyServiceId } from "@claxedo/service-contract"

export class ServiceGatewayUnavailableError extends Error {
  public readonly status = 404

  constructor(
    public readonly serviceId: FirstPartyServiceId,
    public readonly reason: "uninstalled" | "disabled" | "binding_absent" | "response_mismatch",
  ) {
    super("Service unavailable")
    this.name = "ServiceGatewayUnavailableError"
  }
}

/**
 * Deliberately non-enumerating: ordinary callers get the same message and
 * status whether a service is absent, disabled, misbound, or inconsistent.
 */
export function requireEnabledService(
  descriptor: FirstPartyServiceDescriptor | null,
  serviceId: FirstPartyServiceId,
): FirstPartyServiceDescriptor {
  if (!descriptor || descriptor.serviceId !== serviceId) {
    throw new ServiceGatewayUnavailableError(serviceId, "uninstalled")
  }
  if (descriptor.state !== "enabled") throw new ServiceGatewayUnavailableError(serviceId, "disabled")
  return descriptor
}
