import os from "node:os"
import path from "node:path"
import { PROFILE_NAMES, type ProfileName } from "./profiles"

export type Options = {
  readonly target: string
  readonly cookies: string | undefined
  readonly profiles: readonly ProfileName[]
  readonly reps: number
  readonly cpu: number
  readonly out: string
  readonly label: string
  readonly seedTurns: number
  readonly railSessions: number
  readonly longMiB: readonly number[]
  readonly stream: boolean
  readonly census: boolean
  readonly stacks: boolean
  readonly onboardingOnly: boolean
  readonly dist: string | undefined
}

const LOCAL_PROFILES: readonly ProfileName[] = ["fast", "india-staging"]

function isProfileName(value: string): value is ProfileName {
  return (PROFILE_NAMES as readonly string[]).includes(value)
}

export function readOptions(argv: readonly string[]): Options {
  const value = (name: string) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  const target = value("target") ?? "local"
  const profiles = (value("profile") ?? (target === "local" ? LOCAL_PROFILES.join(",") : "none")).split(",").map((name) => {
    if (!isProfileName(name)) throw new Error(`unknown profile ${name}; the profiles are ${PROFILE_NAMES.join(", ")}`)
    return name
  })
  if (target !== "local" && (value("long") || argv.includes("--stream"))) throw new Error("--long and --stream seed their sessions, so they need the local target")
  if (target !== "local" && value("dist")) throw new Error("--dist serves a built app from the local stack, so it needs the local target")
  if (target !== "local" && !value("cookies")) throw new Error("--target=<url> needs --cookies=<file> with the browser's exported cookies for that origin")
  return {
    target,
    cookies: value("cookies"),
    profiles,
    reps: Number(value("reps") ?? "3"),
    cpu: Number(value("cpu") ?? "1"),
    out: value("out") ?? path.join(os.tmpdir(), "claxedo-web-perf", value("label") ?? "run"),
    label: value("label") ?? "run",
    seedTurns: Number(value("seed-turns") ?? "12"),
    railSessions: Number(value("rail-sessions") ?? "8"),
    longMiB: value("long")?.split(",").map(Number) ?? [],
    stream: argv.includes("--stream"),
    census: argv.includes("--census"),
    stacks: argv.includes("--stacks"),
    onboardingOnly: argv.includes("--onboarding-only"),
    dist: value("dist"),
  }
}
