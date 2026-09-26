export const SANDBOX_DRIVERS_PATH = "/api/workspace/drivers"

export function sandboxDriverAuthPath(driverId: string): string {
  return `${SANDBOX_DRIVERS_PATH}/${encodeURIComponent(driverId)}/auth`
}
