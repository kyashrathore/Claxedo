export type SidecarProcessObserver = {
  register(input: {
    pid: number
    stopGracefully(): Promise<void>
    killOwnedTree(): Promise<void>
  }): {
    wslRoot?(input: { handshakeId: string; pid: number; startTicks: string }): void
    exit(input: { reason: "exited" | "error"; exitCode?: number }): void
  }
}

let observer: SidecarProcessObserver | undefined

export function configureSidecarProcessObserver(input?: SidecarProcessObserver) {
  observer = input
}

export function registerOwnedSidecar(input: {
  pid: number
  stopGracefully(): Promise<void>
  killOwnedTree(): Promise<void>
}) {
  return observer?.register(input)
}
