export function resolveComposerSessionID(
  input:
    | {
        sessionID?: () => string | undefined
      }
    | undefined,
  routeSessionID: string | undefined,
) {
  return input?.sessionID?.() ?? routeSessionID
}
