const MAX_HELD_TOKENS = 1024

type HeldToken = { bindingId: string; runtimeToken: string; accessToken: string; revision: number; expiresAt: number }

export class ExchangedTokens {
  private readonly held = new Map<string, HeldToken>()

  get size() { return this.held.size }

  reconcile(bindingId: string, revision: number, now = Date.now()) {
    for (const [key, entry] of this.held) {
      if (entry.expiresAt <= now || (entry.bindingId === bindingId && entry.revision !== revision)) this.held.delete(key)
    }
  }

  get(bindingId: string, runtimeToken: string, revision: number, now = Date.now()): string | undefined {
    this.reconcile(bindingId, revision, now)
    return this.held.get(this.key(bindingId, runtimeToken))?.accessToken
  }

  set(entry: HeldToken, now = Date.now()) {
    this.reconcile(entry.bindingId, entry.revision, now)
    if (entry.expiresAt <= now) return
    const key = this.key(entry.bindingId, entry.runtimeToken)
    this.held.delete(key)
    if (this.held.size === MAX_HELD_TOKENS) this.held.delete(this.held.keys().next().value!)
    this.held.set(key, entry)
  }

  private key(bindingId: string, runtimeToken: string) {
    return `${bindingId}\0${runtimeToken}`
  }
}
