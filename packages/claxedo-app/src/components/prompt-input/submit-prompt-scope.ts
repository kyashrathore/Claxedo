import { sessionViewKey } from "../../shell/identity/session-view-key"

export function uniquePromptScopes(scopes: Array<{ dir: string; id?: string } | undefined>) {
  return scopes.filter(
    (item, index, arr): item is { dir: string; id?: string } =>
      !!item && arr.findIndex((other) => other?.dir === item.dir && other?.id === item.id) === index,
  )
}

export function promptViewScope(input: { directory?: string; sessionId?: string }) {
  return {
    dir: sessionViewKey({
      directory: input.directory,
      sessionId: input.sessionId,
    }),
  }
}
