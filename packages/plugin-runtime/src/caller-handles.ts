import type { PluginCaller } from "@claxedo/plugin-api/backend"

/** How long a handle outlives the request it was minted for, so work the request started can still act as its caller. */
export const PLUGIN_CALLER_HANDLE_TTL_MS = 10 * 60_000

const HANDLE_BYTES = 16

type Entry = { caller: PluginCaller; epoch: number; expiresAt: number | undefined }

export type MintedCallerHandle = Readonly<{
  handle: string
  /** The request or wake this handle was minted for has answered; the handle now expires after `PLUGIN_CALLER_HANDLE_TTL_MS`. */
  settle(): void
}>

/**
 * Caller handles of one plugin's runs, in memory only: a supervisor that
 * restarts has forgotten every handle, and the work that held one can no
 * longer act as its caller. A handle names the caller only to the epoch it was
 * minted under, so a backend that kept one across a reactivation, or another
 * plugin that was handed it, resolves nothing.
 */
export class PluginCallerHandles {
  readonly #entries = new Map<string, Entry>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> = (bytes) => crypto.getRandomValues(bytes),
  ) {}

  mint(epoch: number, caller: PluginCaller): MintedCallerHandle {
    this.#prune(epoch)
    const handle = Array.from(this.random(new Uint8Array(HANDLE_BYTES)), (byte) => byte.toString(16).padStart(2, "0")).join("")
    const entry: Entry = { caller, epoch, expiresAt: undefined }
    this.#entries.set(handle, entry)
    return { handle, settle: () => void (entry.expiresAt ??= this.now() + PLUGIN_CALLER_HANDLE_TTL_MS) }
  }

  /** The caller `handle` was minted for, while it is live under `epoch`. */
  resolve(epoch: number, handle: string): PluginCaller | undefined {
    const entry = this.#entries.get(handle)
    if (!entry || entry.epoch !== epoch) return undefined
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.#entries.delete(handle)
      return undefined
    }
    return entry.caller
  }

  #prune(epoch: number) {
    const now = this.now()
    for (const [handle, entry] of this.#entries) {
      if (entry.epoch < epoch || (entry.expiresAt !== undefined && entry.expiresAt <= now)) this.#entries.delete(handle)
    }
  }
}
