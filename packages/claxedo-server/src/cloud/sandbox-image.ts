import { Daytona, Image, DaytonaNotFoundError } from "@daytonaio/sdk"
import { Log } from "../log"

const log = Log.create({ service: "sandbox-image" })

export const RUNTIME_PORT = 3002
export const WORKSPACE_DIR = "/workspace"
export const RUNTIME_DIR = "/opt/workspace-runtime"

const SNAPSHOT_NAME = process.env.CLAXEDO_SNAPSHOT_NAME || "claxedo-workspace-runtime-v2"

export function buildSandboxImage(): Image {
  return Image.base("node:22-bookworm-slim")
    .runCommands(
      [
        "export DEBIAN_FRONTEND=noninteractive",
        "apt-get update",
        "apt-get install -y --no-install-recommends bash zsh ca-certificates curl git openssh-client procps iproute2 netcat-openbsd python3 make g++",
        "rm -rf /var/lib/apt/lists/*",
      ].join(" && "),
    )
    .runCommands("npm i -g opencode-ai@latest")
    .runCommands("npm i -g tsx")
    // Install workspace-runtime from npm (includes native deps via postinstall)
    .runCommands(
      [
        `mkdir -p ${RUNTIME_DIR}`,
        `cd ${RUNTIME_DIR}`,
        `npm init -y`,
        `npm install @claxedo/workspace-runtime@dev`,
      ].join(" && "),
    )
    .env({ SHELL: "/bin/bash" })
    .workdir(WORKSPACE_DIR)
}

export async function ensureSnapshot(daytona: Daytona): Promise<string> {
  try {
    await daytona.snapshot.get(SNAPSHOT_NAME)
    return SNAPSHOT_NAME
  } catch (err) {
    if (!(err instanceof DaytonaNotFoundError)) throw err
  }

  log.info("Creating sandbox snapshot (this may take a few minutes)...", { name: SNAPSHOT_NAME })
  const image = buildSandboxImage()
  await daytona.snapshot.create(
    { name: SNAPSHOT_NAME, image },
    {
      timeout: 120,
      onLogs: (chunk) => log.info("[snapshot]", { text: chunk }),
    },
  )
  return SNAPSHOT_NAME
}
