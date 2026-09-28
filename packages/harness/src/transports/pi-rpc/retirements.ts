import { errorMessage } from "@claxedo/helpers"
import type { Clock, Logger } from "../../contract"
import { piDeadline } from "./launch"
import type { PiRpc } from "./rpc"

export class UnsettledPiLaunches {
  private readonly held = new Set<PiRpc>()
  private readonly retrying = new Map<PiRpc, Promise<void>>()

  constructor(private readonly clock: Clock, private readonly log: Logger) {}

  async retire(rpc: PiRpc): Promise<void> {
    try {
      await rpc.retire(piDeadline(this.clock))
      this.held.delete(rpc)
    } catch (error) {
      this.log.error("Pi launch retirement did not settle; it is retried when its process exits, when a later launch starts, and at dispose",
        { pid: rpc.process.pid, error: errorMessage(error) })
      this.hold(rpc)
    }
  }

  retryHeld(): void {
    for (const rpc of this.held) void this.retry(rpc)
  }

  async sweep(): Promise<void> {
    await Promise.all([...this.held].map((rpc) => this.retry(rpc)))
  }

  private retry(rpc: PiRpc): Promise<void> {
    const running = this.retrying.get(rpc)
    if (running) return running
    const attempt = this.retire(rpc).finally(() => this.retrying.delete(rpc))
    this.retrying.set(rpc, attempt)
    return attempt
  }

  private hold(rpc: PiRpc): void {
    if (this.held.has(rpc)) return
    this.held.add(rpc)
    void rpc.process.exited.then(() => this.retry(rpc), (error: unknown) => {
      this.log.error("Pi launch exit observation failed", { pid: rpc.process.pid, error: errorMessage(error) })
    })
  }
}
