import path from "node:path"
import type { AppChoice } from "../harness/app"

export type Variant = { name: string; app: AppChoice; dist?: string; port: number }

export type Options = {
  variants: Variant[]
  runs: number
  trace: boolean
  heap: boolean
  long: boolean
  throttle: number
  out: string
  label: string
}

const ORIGIN_PORT_BASE = 48280

export function readOptions(argv: string[]): Options {
  const value = (name: string) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  const variants = (value("variants") ?? "v1,v2").split(",").map((spec, index): Variant => {
    const [name, dist, port] = spec.split(":") as [string, string | undefined, string | undefined]
    return { name, app: name.startsWith("v1") ? "v1" : "v2", dist, port: port ? Number(port) : ORIGIN_PORT_BASE + index }
  })
  return {
    variants,
    runs: Number(value("runs") ?? "2"),
    trace: argv.includes("--trace"),
    heap: argv.includes("--heap"),
    long: argv.includes("--long"),
    throttle: Number(value("throttle") ?? "1"),
    out: value("out") ?? path.join(import.meta.dirname, "out"),
    label: value("label") ?? "base",
  }
}

export function runOrder(options: Options): Variant[] {
  const order: Variant[] = []
  for (let run = 0; run < options.runs; run += 1) order.push(...(run % 2 === 0 ? options.variants : [...options.variants].reverse()))
  return order
}
