import { listSandboxDrivers } from "../../../../sandbox-manager/src/driver-catalog"

export function unconfiguredWorkspaceDriversResponse() {
  return listSandboxDrivers(
    { default_driver: "daytona" },
    {},
    new Set(),
  )
}
