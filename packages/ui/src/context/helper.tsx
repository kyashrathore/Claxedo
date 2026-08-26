import { createContext, createMemo, Show, untrack, useContext, type ParentProps, type Accessor } from "solid-js"

export function createSimpleContext<T, Props extends Record<string, any>>(
  input: {
    name: string
    init: ((input: Props) => T) | (() => T)
  } & (T extends { ready: unknown } ? { gate: boolean } : { gate?: boolean }),
) {
  const Context = createContext<T | null>(null)

  return {
    provider: (props: ParentProps<Props>) => {
      const init = untrack(() => input.init(props))
      const gate = input.gate ?? true

      if (!gate) {
        return <Context value={init}>{props.children}</Context>
      }

      // Access init.ready inside the memo to make it reactive for getter properties
      const isReady = createMemo(() => {
        // @ts-expect-error
        const ready = init.ready as Accessor<boolean> | boolean | undefined
        return ready === undefined || (typeof ready === "function" ? ready() : ready)
      })
      return (
        <Show when={isReady()}>
          <Context value={init}>{props.children}</Context>
        </Show>
      )
    },
    use() {
      const value = useContext(Context)
      if (!value) throw new Error(`${input.name} context must be used within a context provider`)
      return value
    },
  }
}
