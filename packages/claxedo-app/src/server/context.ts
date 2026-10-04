import { createContext, useContext } from "solid-js"
import type { Server } from "./api"

export const ServerContext = createContext<Server>()

export function useServer(): Server {
  const server = useContext(ServerContext)
  if (!server) throw new Error("useServer needs a ServerContext provider above it")
  return server
}
