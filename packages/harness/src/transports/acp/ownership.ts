import { availableParallelism } from "node:os"
import { errorMessage, limitConcurrency } from "@claxedo/helpers"
import { AcpTransportError } from "./errors"

type Retire = () => Promise<void>

export class AcpPeerOwnership {
  private readonly owned = new Set<Retire>()
  readonly launch = limitConcurrency(availableParallelism())

  own(peer: { retire: Retire }): void {
    this.owned.add(peer.retire)
  }

  async retire(peer: { retire: Retire }): Promise<void> {
    await peer.retire()
    this.owned.delete(peer.retire)
  }

  async retireAll(): Promise<void> {
    const settled = await Promise.allSettled([...this.owned].map((retire) => this.retire({ retire })))
    const failures = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
    if (failures.length === 0) return
    throw new AcpTransportError("ownership", failures.map((failure) => errorMessage(failure)).join("; "), new AggregateError(failures, "ACP peer retirement failed"))
  }
}
