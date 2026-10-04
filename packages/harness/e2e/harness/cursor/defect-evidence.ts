import type { Stack } from "../stack"
import { unexpectedEgress } from "../egress-guard"

export function cursorBrokerDefect(stack: Stack, backendIndex: number, error: unknown): Error | undefined {
  const requests = stack.cursor[backendIndex]?.requests ?? []
  const exchanged = requests.some((request) => request.path === "/auth/exchange_user_api_key")
  const reachedConnectBackend = requests.some((request) => request.path.startsWith("/aiserver.v1/")
    || request.path.startsWith("/agent.v1/"))
  const daemonLog = stack.daemon.log()
  const refusedConnect = /\[ConnectError\]: \[unauthenticated\]/.test(daemonLog)
  if (!exchanged || reachedConnectBackend || !refusedConnect || unexpectedEgress(stack.egress.attempts).length) return undefined

  const daemonDied = /\[claxedo-server\] FATAL uncaught exception:.*\[ConnectError\]: \[unauthenticated\]/.test(daemonLog)
  return new Error(
    `H-20: Cursor exchanged its placeholder at the scripted backend, then the broker refused its Connect RPC as unauthenticated`
      + (daemonDied ? "; the uncaught SDK ConnectError also ended the daemon (H-21)" : ""),
    { cause: error },
  )
}
