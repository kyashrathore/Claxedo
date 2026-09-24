import type { Server, TerminalsApi } from "@/server"

export function terminalsApi(server: Server): TerminalsApi {
  return server.terminals
}
