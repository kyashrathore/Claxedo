import { errorMessage } from "@claxedo/helpers"
import type { Clock, Logger } from "../../contract"
import { piDeadline } from "./launch"
import type { PiRpc } from "./rpc"

export class UnsettledPiLaunches {
  private readonly held = new Set<PiRpc>()

  constructor(private readonly clock: Clock, private readonly log: Logger) {}

  get size(): number {
    return this.held.size
  }

  async retire(rpc: PiRpc): Promise<void> {
    try {
      await rpc.retire(piDeadline(this.clock))
      this.held.delete(rpc)
    } catch (error) {
      this.log.error("Pi launch retirement did not settle; it is retried when its process exits and before the next launch",
        { pid: rpc.process.pid, error: errorMessage(error) })
      this.hold(rpc)
    }
  }

  async sweep(): Promise<void> {
    await Promise.all([...this.held].map((rpc) => this.retire(rpc)))
  }

  private hold(rpc: PiRpc): void {
    if (this.held.has(rpc)) return
    this.held.add(rpc)
    void rpc.process.exited.then(() => this.retire(rpc), (error: unknown) => {
      this.log.error("Pi launch exit observation failed", { pid: rpc.process.pid, error: errorMessage(error) })
    })
  }
}
