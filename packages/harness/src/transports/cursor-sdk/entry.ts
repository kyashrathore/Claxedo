import { createKeyedSerializer } from "@claxedo/helpers"
import type { HarnessSession, SessionBroker, StartInput } from "../../contract"
import { TransportError } from "../../contract/errors"
import type { CursorPluginOptions } from "../../profiles/cursor"
import type { CursorCredential } from "./credentials"
import type { CursorHost, CursorHostKey, CursorHostRegistry } from "./host-registry"

export type CursorEntry = {
  session: HarnessSession
  input: StartInput
  broker: SessionBroker
  credential: CursorCredential
  host: CursorHostKey
  process: CursorHost
  plugins: CursorPluginOptions
  busy: boolean
  starting?: { turnId: string; launched: boolean; abort: AbortController }
  reopen: boolean
  closing?: Promise<void>
}

export class CursorEntryLifecycle {
  private readonly serial = createKeyedSerializer<CursorEntry>()

  assertOpen(entry: CursorEntry): void {
    if (entry.closing) throw new TransportError("cursor", "session", "Cursor session is closing")
  }

  run<T>(entry: CursorEntry, operation: () => Promise<T>): Promise<T> {
    this.assertOpen(entry)
    return this.serial.run(entry, async () => {
      this.assertOpen(entry)
      return operation()
    })
  }

  async acquire(entry: CursorEntry, registry: CursorHostRegistry, key: CursorHostKey): Promise<CursorHost> {
    const host = await registry.acquire(key)
    if (entry.closing) {
      await registry.release(key, host)
      this.assertOpen(entry)
    }
    return host
  }

  current(entry: CursorEntry, registry: CursorHostRegistry): Promise<CursorHost> {
    return this.run(entry, async () => {
      if (!entry.process.failed) return entry.process
      const previous = entry.process
      entry.process = await this.acquire(entry, registry, entry.host)
      await registry.release(entry.host, previous)
      return entry.process
    })
  }

  close(entry: CursorEntry, operation: () => Promise<void>): Promise<void> {
    if (!entry.closing) entry.closing = this.serial.run(entry, operation)
    return entry.closing
  }
}
