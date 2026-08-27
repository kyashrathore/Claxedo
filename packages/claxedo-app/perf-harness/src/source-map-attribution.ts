import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

/**
 * Original-source attribution for V8 CPU profiles taken against a production build.
 *
 * Profiling an unminified build would name functions for free, but it would be
 * profiling a different program: a build with no mangling, no inlining budget
 * shift, and a parse cost several times the shipped one. So the profile is taken
 * against the exact artifact that ships and the frames are walked back through
 * the build's own sourcemaps here.
 *
 * Only the base64-VLQ `mappings` decode is needed — no dependency carries its
 * weight for a `(line, column) -> (source, line)` lookup on a handful of chunks.
 */

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const CHAR_TO_INT = new Map([...BASE64].map((character, index) => [character, index]))

type Segment = {
  generatedColumn: number
  sourceIndex: number
  sourceLine: number
  sourceColumn: number
  nameIndex?: number
}

type DecodedMap = {
  sources: (string | null)[]
  sourcesContent: (string | null)[]
  names: string[]
  /** Segments per generated line, ascending by generated column. */
  lines: Segment[][]
}

export type OriginalPosition = {
  source: string
  line: number
  column: number
  name?: string
}

export function decodeSourceMap(raw: string): DecodedMap {
  const parsed = JSON.parse(raw) as {
    sources: string[]
    sourcesContent?: (string | null)[]
    sourceRoot?: string
    names?: string[]
    mappings: string
  }
  const sourceRoot = parsed.sourceRoot ?? ""
  const sources = parsed.sources.map((source) =>
    source === null ? null : sourceRoot ? `${sourceRoot.replace(/\/$/u, "")}/${source}` : source,
  )
  const lines: Segment[][] = []
  let sourceIndex = 0
  let sourceLine = 0
  let sourceColumn = 0
  let nameIndex = 0
  for (const line of parsed.mappings.split(";")) {
    const segments: Segment[] = []
    let generatedColumn = 0
    if (line.length > 0) {
      for (const segment of line.split(",")) {
        if (segment.length === 0) continue
        const fields = decodeVlq(segment)
        generatedColumn += fields[0] ?? 0
        if (fields.length >= 4) {
          sourceIndex += fields[1]!
          sourceLine += fields[2]!
          sourceColumn += fields[3]!
          if (fields.length >= 5) nameIndex += fields[4]!
          segments.push({
            generatedColumn,
            sourceIndex,
            sourceLine,
            sourceColumn,
            nameIndex: fields.length >= 5 ? nameIndex : undefined,
          })
        }
      }
    }
    lines.push(segments)
  }
  return {
    sources,
    sourcesContent: parsed.sourcesContent ?? [],
    names: parsed.names ?? [],
    lines,
  }
}

function decodeVlq(segment: string): number[] {
  const values: number[] = []
  let shift = 0
  let value = 0
  for (const character of segment) {
    const digit = CHAR_TO_INT.get(character)
    if (digit === undefined) throw new Error(`invalid base64 vlq character ${character}`)
    const hasContinuation = (digit & 32) !== 0
    value += (digit & 31) << shift
    if (hasContinuation) {
      shift += 5
      continue
    }
    const negative = (value & 1) === 1
    const magnitude = value >> 1
    values.push(negative ? (magnitude === 0 ? -0x80000000 : -magnitude) : magnitude)
    shift = 0
    value = 0
  }
  return values
}

/**
 * The last mapping at or before `column` on `line`.
 *
 * V8 reports a frame at the position its function literal starts, which is not
 * guaranteed to be a mapping boundary after minification, so an exact-column
 * lookup would miss most frames. Walking back to the nearest preceding segment
 * is what every consumer of a sourcemap does for the same reason.
 */
export function originalPositionFor(
  map: DecodedMap,
  line: number,
  column: number,
): OriginalPosition | undefined {
  const segments = map.lines[line]
  if (!segments || segments.length === 0) return undefined
  let low = 0
  let high = segments.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (segments[middle]!.generatedColumn <= column) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  const segment = segments[found === -1 ? 0 : found]!
  const source = map.sources[segment.sourceIndex]
  if (!source) return undefined
  return {
    source,
    line: segment.sourceLine + 1,
    column: segment.sourceColumn,
    name: segment.nameIndex === undefined ? undefined : map.names[segment.nameIndex],
  }
}

export type Attributor = {
  /** `line` and `column` are the zero-based pair a V8 call frame reports. */
  attribute: (url: string, line: number, column: number) => OriginalPosition | undefined
  sourceLineText: (position: OriginalPosition) => string | undefined
  mappedChunkCount: number
}

/**
 * Loads every `*.js.map` under `buildDirectory` and keys them by the URL path
 * the browser requests, so a profile frame's `url` resolves without guessing.
 */
export async function loadBuildAttributor(buildDirectory: string): Promise<Attributor> {
  const maps = new Map<string, DecodedMap>()
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (!entry.name.endsWith(".js.map")) continue
      const relative = path.relative(buildDirectory, absolute).replace(/\.map$/u, "")
      maps.set(relative, decodeSourceMap(await readFile(absolute, "utf8")))
    }
  }
  await walk(buildDirectory)

  const forUrl = (url: string) => {
    let pathname: string
    try {
      pathname = new URL(url).pathname
    } catch {
      pathname = url
    }
    const relative = pathname.replace(/^\//u, "")
    return maps.get(relative) ?? maps.get(path.basename(relative))
  }

  return {
    mappedChunkCount: maps.size,
    attribute: (url, line, column) => {
      const map = forUrl(url)
      if (!map) return undefined
      return originalPositionFor(map, line, column)
    },
    sourceLineText: (position) => {
      for (const map of maps.values()) {
        const index = map.sources.indexOf(position.source)
        if (index === -1) continue
        const content = map.sourcesContent[index]
        if (!content) continue
        return content.split("\n")[position.line - 1]?.trim()
      }
      return undefined
    },
  }
}

/**
 * Collapses a vite/rollup source path (`../../src/features/...`, or a
 * `\0`-prefixed virtual id) to a repository-relative path a reader can open.
 */
export function normalizeSourcePath(source: string): string {
  const cleaned = source.replace(/^\0/u, "").replace(/\?.*$/u, "")
  const packaged = cleaned.match(/(node_modules\/(?:@[^/]+\/)?[^/]+)\/(.*)$/u)
  if (packaged) return `${packaged[1]}/${packaged[2]}`
  const inRepo = cleaned.match(/(?:^|\/)(packages\/[^/]+\/.*)$/u)
  if (inRepo) return inRepo[1]!
  return cleaned.replace(/^(\.\.\/)+/u, "")
}

/**
 * Byte-offset -> (line, column) for the built chunks.
 *
 * V8's precise-coverage report addresses functions by their byte offset in the
 * script, while sourcemaps are keyed by line and column, so counting how often
 * a function ran needs this bridge before {@link Attributor} can name it.
 */
export type OffsetResolver = {
  /** Zero-based line and column of `offset` in the chunk `url` names. */
  resolve: (url: string, offset: number) => { line: number; column: number } | undefined
}

export async function loadBuildOffsetResolver(buildDirectory: string): Promise<OffsetResolver> {
  const lineStarts = new Map<string, number[]>()
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (!entry.name.endsWith(".js")) continue
      const text = await readFile(absolute, "utf8")
      const starts = [0]
      for (let index = 0; index < text.length; index++) {
        if (text.charCodeAt(index) === 10) starts.push(index + 1)
      }
      lineStarts.set(path.relative(buildDirectory, absolute), starts)
    }
  }
  await walk(buildDirectory)

  return {
    resolve: (url, offset) => {
      let pathname: string
      try {
        pathname = new URL(url).pathname
      } catch {
        pathname = url
      }
      const relative = pathname.replace(/^\//u, "")
      const starts = lineStarts.get(relative) ?? lineStarts.get(path.basename(relative))
      if (!starts) return undefined
      let low = 0
      let high = starts.length - 1
      let line = 0
      while (low <= high) {
        const middle = (low + high) >> 1
        if (starts[middle]! <= offset) {
          line = middle
          low = middle + 1
        } else {
          high = middle - 1
        }
      }
      return { line, column: offset - starts[line]! }
    },
  }
}
