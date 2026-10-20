import { createStore } from "solid-js/store"
import { toAppError, type ProviderAuthorization } from "@/server"

export type ConnectAudience = "own" | "org"

export function createConnectState() {
  const [store, setStore] = createStore({
    audience: "own" as ConnectAudience,
    methodIndex: undefined as number | undefined,
    authorization: undefined as ProviderAuthorization | undefined,
    state: undefined as "pending" | "auto" | "code" | "error" | undefined,
    value: "",
    label: "",
    code: "",
    error: undefined as string | undefined,
    saving: false,
  })
  const pickMethod = (index: number) =>
    setStore({ methodIndex: index < 0 ? undefined : index, authorization: undefined, state: undefined, error: undefined, value: "", code: "" })
  const pickAudience = (audience: ConnectAudience) => {
    setStore("audience", audience)
    pickMethod(-1)
  }
  const fail = (error: unknown) => setStore({ state: "error", saving: false, error: toAppError(error).message })
  const forgiven = () => ({ error: undefined, state: store.state === "error" ? undefined : store.state })
  const setValue = (value: string) => setStore({ value, ...forgiven() })
  const setCode = (code: string) => setStore({ code, ...forgiven() })
  return { store, setStore, pickMethod, pickAudience, fail, setValue, setCode }
}
