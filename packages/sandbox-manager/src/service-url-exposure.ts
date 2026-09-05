import type { SandboxDriverID } from "@claxedo/sandbox-contract"

export type SandboxServiceUrlExposure = {
  source: "driver-service-url"
  access: "private" | "public" | "driver-authenticated" | "unknown"
  driver: SandboxDriverID
  fallbackAccess?: "private" | "public" | "driver-authenticated" | "unknown"
  note?: string
}

export function sandboxServiceUrlExposure(driver: SandboxDriverID): SandboxServiceUrlExposure {
  if (driver === "docker") {
    return {
      source: "driver-service-url",
      access: "private",
      driver,
      note: "Docker service URLs resolve to a local loopback port on the host.",
    }
  }
  if (driver === "daytona") {
    return {
      source: "driver-service-url",
      access: "driver-authenticated",
      driver,
      fallbackAccess: "public",
      note: "Daytona uses a signed preview URL when available and falls back to a preview link.",
    }
  }
  return {
    source: "driver-service-url",
    access: "public",
    driver,
  }
}
