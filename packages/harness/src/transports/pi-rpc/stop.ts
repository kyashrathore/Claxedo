import type { Deadline } from "../../contract"
import type { PiRpc } from "./rpc"

export async function stopPiRun(rpc: PiRpc, deadline: Deadline): Promise<void> {
  const results = await Promise.allSettled([rpc.request("clear_queue", {}, deadline), rpc.request("abort", {}, deadline)])
  const failure = results.find((result) => result.status === "rejected")
  if (failure?.status === "rejected") throw failure.reason
}
