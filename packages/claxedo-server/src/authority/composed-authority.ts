/**
 * Recognizing a capability on the composed control-plane authority.
 *
 * `ControlPlaneServices.authority` is typed `WorkspaceAuthority`, but the object
 * a composition actually builds also implements `PrivateSessionAuthority`,
 * `SessionTurnAuthority` and the runtime-session port — `createCoreAuthority`
 * assembles all of them into one value. TypeScript has no view of that, so
 * every consumer used to write `services.authority as unknown as
 * SessionTurnAuthority`, an assertion a composition MISSING those methods
 * satisfies just as happily; the failure then surfaced at the call as
 * `undefined is not a function`, far from the composition that omitted it.
 *
 * This is the one place that reaches across, and it answers the question with a
 * runtime check rather than a claim: every member the port names must be
 * present and callable before the value is treated as that port. A guard that
 * gets `false` refuses the composition where it was composed.
 *
 * Pass the port's canonical method inventory where one exists
 * (`SESSION_TURN_AUTHORITY_METHODS`, `PRIVATE_SESSION_AUTHORITY_METHODS`) —
 * those are `satisfies`-checked against their port, so a port that grows a
 * method grows the check with it.
 */
export function isComposedAuthorityPort<Port extends object>(
  authority: object | undefined,
  members: readonly (keyof Port & string)[],
): authority is Port {
  if (authority === undefined) return false
  return members.every((member) => typeof Reflect.get(authority, member) === "function")
}
