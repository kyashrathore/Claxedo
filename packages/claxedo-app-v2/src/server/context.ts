import { createContext, useContext } from "solid-js"
import type { Server } from "./index"

export const ServerContext = createContext<Server>()

export function useServer(): Server {
  const server = useContext(ServerContext)
  if (!server) throw new Error("useServer needs a ServerContext provider above it")
  return server
}
