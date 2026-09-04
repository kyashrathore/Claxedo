/** A harness discovery covers under D3 ("Personal" — plugins installed outside Claxedo). */
export type MachineDiscoveryHarnessId = "claude" | "cursor" | "codex"

export type MachineInstalledEntry = {
  name: string
  version?: string
  root: string
  marketplace?: string
  /** True when the entry is one Claxedo itself manages (the Directory's "Personal" section hides these). */
  ownedByClaxedo: boolean
}

export type MachineInstalledHarness = {
  harnessId: MachineDiscoveryHarnessId
  entries: MachineInstalledEntry[]
}

export type MachineInstalledResult = {
  harnesses: MachineInstalledHarness[]
}
