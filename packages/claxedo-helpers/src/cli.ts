import { parsePositiveNumber } from "./number"

/**
 * Reads a flag out of an argv array the CALLER passes, which keeps this
 * runtime-neutral and testable. Both grammars in use are accepted: the space
 * form `--name value` and the equals form `--name=value`.
 *
 * No trimming and no emptiness filtering — an explicitly supplied empty string
 * is returned as "". Only a missing flag, or a space-form flag that is the last
 * element, falls back.
 */
export function cliFlagValue(
  args: readonly string[],
  name: string,
  fallback?: string,
): string | undefined {
  const flag = `--${name}`
  for (let index = 0; index < args.length; index += 1) {
    const entry = args[index]
    if (entry === undefined) continue
    if (entry === flag) return args[index + 1] ?? fallback
    if (entry.startsWith(`${flag}=`)) return entry.slice(flag.length + 1)
  }
  return fallback
}

/** A missing flag, a non-numeric value, NaN, Infinity, 0 and negatives all yield `fallback`. */
export function cliFlagPositiveNumber(args: readonly string[], name: string, fallback: number): number {
  return parsePositiveNumber(cliFlagValue(args, name)) ?? fallback
}
