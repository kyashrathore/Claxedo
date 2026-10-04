import { identityFromSpawn, readCreationIdentity, type CreationIdentity } from "@claxedo/process-ownership/launch"

type Observation = { observed?: CreationIdentity; identity?: CreationIdentity }

type Probe = {
  read: typeof readCreationIdentity
  now: () => number
  wait: () => Promise<void>
}

const probe: Probe = {
  read: readCreationIdentity,
  now: Date.now,
  wait: () => new Promise((resolve) => setTimeout(resolve, 10)),
}

export async function readPtyCreationIdentity(pid: number, spawnedAt: number, exited: () => boolean, io: Probe = probe): Promise<Observation> {
  if (!Number.isInteger(pid) || pid <= 0 || exited()) return {}
  const deadline = io.now() + 1_000
  let first: CreationIdentity | undefined
  for (;;) {
    const observed = await io.read(pid)
    if (!observed || exited()) return { observed }
    const started = identityFromSpawn(observed, spawnedAt)
    if (!started || started.pid !== pid || (first && (first.bootTime !== started.bootTime || first.startSecond !== started.startSecond || first.startedAtMs !== started.startedAtMs || first.source !== started.source))) return { observed }
    first ??= started
    if (started.processGroupId === pid) return { observed, identity: started }
    if (io.now() >= deadline) return { observed }
    await io.wait()
  }
}
