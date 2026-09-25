export function deliveredUnsupportedOperation(route: string, body: unknown): { route: string; body: unknown } {
  if (process.env.CLAXEDO_E2E_H37_ROUTE_COMMAND_TO_TURN !== "1" || !route.endsWith("/command")) return { route, body }
  return { route: route.slice(0, -"command".length) + "message", body: { parts: [{ type: "text", text: "H37 unexpected harness turn" }] } }
}
