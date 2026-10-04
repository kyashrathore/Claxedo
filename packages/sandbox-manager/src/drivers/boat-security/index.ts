import seccomp from "./seccomp.json"
import apparmorLines from "./apparmor.json"
import { shell } from "../../command"

const SECCOMP_PATH = ".claxedo-runtime-seccomp.json"
const APPARMOR_PATH = ".claxedo-runtime.apparmor"
const APPARMOR_NAME = "claxedo-workspace-runtime"
const FLAGS = "--cap-drop ALL --cap-add SETFCAP --cap-add CHOWN --security-opt no-new-privileges"

export async function boatContainerSecurity() {
  const files = [
    { path: SECCOMP_PATH, content: JSON.stringify(seccomp) },
    { path: APPARMOR_PATH, content: apparmorLines.join("\n") },
  ]
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ files, flags: FLAGS })))
  const identity = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  return {
    files,
    identity,
    args: `${FLAGS} --security-opt seccomp="$(pwd)/${SECCOMP_PATH}" $claxedo_apparmor_arg `
      + `--label claxedo.runtime.security=${identity}`,
    prepare: `claxedo_security_options="$(docker info --format '{{json .SecurityOptions}}')" `
      + `&& claxedo_apparmor_arg= && case "$claxedo_security_options" in *name=apparmor*) `
      + `sudo -n apparmor_parser -r -W ${shell(APPARMOR_PATH)} `
      + `&& claxedo_apparmor_arg=${shell(`--security-opt=apparmor=${APPARMOR_NAME}`)} ;; esac`,
  }
}

export type BoatContainerSecurity = Awaited<ReturnType<typeof boatContainerSecurity>>
