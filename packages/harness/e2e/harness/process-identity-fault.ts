import fs from "node:fs/promises"
import path from "node:path"

export async function blockProcessIdentity(dataDir: string) {
  const bin = path.join(dataDir, "identity-fault-bin")
  const gate = path.join(bin, "blocked")
  await fs.mkdir(bin)
  if (process.env.CLAXEDO_E2E_H8_PS_PASSTHROUGH !== "1") await fs.writeFile(gate, "")
  await fs.writeFile(path.join(bin, "ps"), `#!/bin/sh
if [ -e '${gate}' ]; then
  echo 'scripted process identity probe refusal' >&2
  exit 2
fi
exec /bin/ps "$@"
`, { mode: 0o755 })
  return { bin, release: () => fs.rm(gate) }
}
