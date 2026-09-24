import { useServer, type Server, type TerminalsApi } from "@/server"

export function useTerminalsApi(): TerminalsApi {
  return useServer().terminals
}

export function terminalsApi(server: Server): TerminalsApi {
  return server.terminals
}
