import { execFileSync } from "node:child_process"
import { packageRoot } from "./lib/files"

const protectedAreas = [
  { flow: 30, folders: ["src/transcript", "src/session/view/timeline"] },
  { flow: 31, folders: ["src/session/list"] },
]

function main(): void {
  const changed = [...git("diff", "--name-only", "--relative", "HEAD"), ...git("ls-files", "--others", "--exclude-standard")]
  const flows = protectedAreas
    .filter((area) => changed.some((path) => area.folders.some((folder) => path === folder || path.startsWith(`${folder}/`))))
    .map((area) => area.flow)
  console.error(flows.length > 0 ? `protected areas changed: flows ${flows.join(" and ")} must run` : "no protected area changed")
}

function git(...args: string[]): string[] {
  return execFileSync("git", args, { cwd: packageRoot, encoding: "utf8" }).split("\n").filter(Boolean)
}

main()
