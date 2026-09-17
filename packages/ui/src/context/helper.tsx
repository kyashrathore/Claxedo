import { createContext, createMemo, Show, useContext, type ParentProps } from "solid-js"

/*
 * A context value may expose `ready` as a boolean or an accessor to gate its
 * provider. `T` is opaque here, so the flag is read structurally rather than
 * asserted onto the value.
 */
function isReadyValue(init: unknown): boolean {
  if (typeof init !== "object" || init === null || !("ready" in init)) return true
  const ready: unknown = init.ready
  if (typeof ready === "function") return Boolean(ready())
  return ready === undefined || Boolean(ready)
}

export function createSimpleContext<T, Props extends Record<string, any>>(
  input: {
    name: string
    init: ((input: Props) => T) | (() => T)
  } & (T extends { ready: unknown } ? { gate: boolean } : { gate?: boolean }),
) {
  const ctx = createContext<T>()

  return {
    provider: (props: ParentProps<Props>) => {
      const init = input.init(props)
      const gate = input.gate ?? true

      if (!gate) {
        return <ctx.Provider value={init}>{props.children}</ctx.Provider>
      }

      // Access init.ready inside the memo to make it reactive for getter properties
      const isReady = createMemo(() => isReadyValue(init))
      return (
        <Show when={isReady()}>
          <ctx.Provider value={init}>{props.children}</ctx.Provider>
        </Show>
      )
    },
    /*
     * An arrow property, not a method: every caller destructures this off the
     * returned object (`const { use: useThing } = createSimpleContext(...)`),
     * which would unbind a method.
     */
    use: () => {
      const value = useContext(ctx)
      if (!value) throw new Error(`${input.name} context must be used within a context provider`)
      return value
    },
    /** For a consumer that has a sensible behaviour without the provider. */
    useOptional: () => useContext(ctx),
  }
}
