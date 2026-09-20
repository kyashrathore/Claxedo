import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { dict as baseEn } from "./en"
import { dict as sourceControlEn } from "./source-control/en"
import { dict as machinesEn } from "./machines/en"
import { cloudStrings } from "./cloud-strings"
import { LOCALE_ENTRIES, type LocaleCode } from "./locales"

// A workspace is a folder on a machine, and a machine is shown by the name it
// derived for itself. So no screen may name a workspace's TYPE, and no screen
// may name a machine by a word whose meaning changes with the device reading
// it: "This machine" on the desktop and on the web are two different machines.

/** Phrases that name a workspace's type, or a machine deictically. */
const FORBIDDEN_PHRASES = [
  "user-hosted",
  "user hosted",
  "local workspace",
  "cloud workspace",
  "hosted workspace",
  "local project",
]

/** A whole value that is a machine's name rather than a sentence about one. */
const FORBIDDEN_LABELS = ["this machine", "local", "cloud", "user-hosted", "hosted", "local workspace"]

/**
 * The same rule for a screen, minus the bare kind words.
 *
 * In a dictionary a value of exactly "local" is a label. In a component a
 * literal `"local"` is a wire kind, a route segment or a discriminant, and
 * forbidding it here would make this suite a vocabulary rename detector rather
 * than a copy audit.
 */
const FORBIDDEN_SCREEN_LABELS = ["this machine", "this device", "local workspace", "cloud workspace", "hosted workspace"]

/**
 * Each locale's own lowercased word for the three things the send-level
 * disclosure must still say: the machine the agent reads, the other sessions
 * whose transcripts it can reach, and the cloud environment sharing belongs
 * on. A translation is free to reword the sentence; dropping one of these
 * clauses describes a product that does not exist, and is invisible to a
 * reviewer who does not read the language.
 */
const DISCLOSURE_MARKERS: Record<LocaleCode, { machine: string; transcripts: string; cloud: string }> = {
  en: { machine: "machine", transcripts: "transcripts", cloud: "cloud" },
  ar: { machine: "جهاز", transcripts: "نصوص", cloud: "سحابية" },
  bs: { machine: "uređaj", transcripts: "transkripte", cloud: "cloud" },
  br: { machine: "máquina", transcripts: "transcri", cloud: "nuvem" },
  da: { machine: "maskin", transcripts: "udskrift", cloud: "cloud" },
  de: { machine: "gerät", transcripts: "transkripte", cloud: "cloud" },
  es: { machine: "equipo", transcripts: "transcripciones", cloud: "nube" },
  fr: { machine: "machine", transcripts: "transcriptions", cloud: "cloud" },
  ja: { machine: "マシン", transcripts: "トランスクリプト", cloud: "クラウド" },
  ko: { machine: "컴퓨터", transcripts: "대화 기록", cloud: "클라우드" },
  no: { machine: "maskin", transcripts: "utskrift", cloud: "sky" },
  pl: { machine: "komputer", transcripts: "transkryp", cloud: "chmur" },
  ru: { machine: "компьютер", transcripts: "стенограмм", cloud: "облачн" },
  th: { machine: "เครื่อง", transcripts: "บันทึกการสนทนา", cloud: "คลาวด์" },
  tr: { machine: "makine", transcripts: "döküm", cloud: "bulut" },
  zh: { machine: "机器", transcripts: "记录", cloud: "云" },
  zht: { machine: "機器", transcripts: "逐字稿", cloud: "雲端" },
}

function offendingPhrases(value: string): string[] {
  const text = value.toLowerCase()
  return FORBIDDEN_PHRASES.filter((phrase) => text.includes(phrase))
}

async function loadDict(code: LocaleCode): Promise<Record<string, string>> {
  const file = code === "br" ? "pt-BR" : code
  const base = (await import(`./${file}`)) as { dict: Record<string, string> }
  const sourceControl = (await import(`./source-control/${file}`)) as { dict: Record<string, string> }
  const machines = (await import(`./machines/${file}`)) as { dict: Record<string, string> }
  if (code === "en") return { ...base.dict, ...sourceControl.dict, ...machines.dict }
  const provider = (await import(`./provider-settings/${file}`)) as { dict: Record<string, string> }
  return { ...base.dict, ...provider.dict, ...sourceControl.dict, ...machines.dict }
}

const en = { ...baseEn, ...sourceControlEn, ...machinesEn }

describe("machine and workspace copy: the dictionaries", () => {
  test("English names no workspace type and no machine by a word that moves with the reader", async () => {
    const phrases = Object.entries(en)
      .flatMap(([key, value]) => offendingPhrases(value).map((phrase) => `${key}: ${phrase}`))
    expect(phrases).toEqual([])

    const labels = Object.entries(en)
      .filter(([, value]) => FORBIDDEN_LABELS.includes(value.trim().toLowerCase()))
      .map(([key, value]) => `${key}: ${value}`)
    expect(labels).toEqual([])
  })

  // "Host" is the code's word for an enrolled machine. On a screen it reads as
  // a server somebody else runs, which is the opposite of what the row says.
  test("English calls a machine a machine, never a host", async () => {
    const offenders = Object.entries(en)
      .filter(([, value]) => /\bhosts?\b/i.test(value))
      .map(([key, value]) => `${key}: ${value}`)
    expect(offenders).toEqual([])
  })

  test("every translated locale carries the same rule, so a locale cannot reintroduce the old vocabulary", async () => {
    const offenders: string[] = []
    for (const entry of LOCALE_ENTRIES) {
      const dict = await loadDict(entry.code)
      for (const [key, value] of Object.entries(dict)) {
        for (const phrase of offendingPhrases(value)) offenders.push(`${entry.code} ${key}: ${phrase}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test("the cloud dictionary names a cloud machine an environment, never a workspace type", () => {
    const offenders = Object.entries(cloudStrings).flatMap(([locale, strings]) =>
      Object.entries(strings as Record<string, string>)
        .flatMap(([key, value]) => offendingPhrases(value).map((phrase) => `${locale} ${key}: ${phrase}`)))
    expect(offenders).toEqual([])
  })

  test("the share disclosure and both share levels are translated copy, not constants in the component", () => {
    const control = readFileSync(
      join(import.meta.dir, "../../features/session/ui/components/session-people-control.tsx"),
      "utf8",
    )
    expect(control).not.toContain("The agent runs on the workspace's machine")
    expect(control).toContain("session.share.disclosure.send")
    expect(control).toContain("session.share.level.follow")
  })

  test("every locale's disclosure still names the machine, the other sessions' transcripts, and the cloud environment", async () => {
    const incomplete: string[] = []
    for (const entry of LOCALE_ENTRIES) {
      const value = (await loadDict(entry.code))["session.share.disclosure.send"]?.toLowerCase() ?? ""
      const markers = DISCLOSURE_MARKERS[entry.code]
      for (const [element, marker] of Object.entries(markers)) {
        if (!value.includes(marker)) incomplete.push(`${entry.code}: ${element}`)
      }
    }
    expect(incomplete).toEqual([])
  })

  test("the machines dictionary has exactly one file per locale the manifest lists", () => {
    const files = readdirSync(join(import.meta.dir, "machines"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => name.replace(/\.ts$/, ""))
      .sort()
    const expected = LOCALE_ENTRIES.map((entry) => (entry.code === "br" ? "pt-BR" : entry.code)).sort()
    expect(files).toEqual(expected)
  })
})

// The screens carry copy inline as well as through the dictionaries, so the
// same rule is applied to what they render — every one of them, because an
// allowlist of the files that name a machine today is an allowlist of the
// files someone remembered. Comments are stripped first: they explain the
// wire, where "cloud workspace" is the right word for the row and no user ever
// reads it.
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"\\])\/\/[^\n]*/g, "$1")
}

/**
 * Every source file under a directory, minus the tests.
 *
 * A test file is not a screen, and several of them quote the forbidden
 * vocabulary on purpose — this one included.
 */
function sourceFiles(relative: string): string[] {
  const root = join(import.meta.dir, "../..", relative)
  return (readdirSync(root, { recursive: true }) as string[])
    .filter((name) => /\.tsx?$/.test(name))
    .filter((name) => !/\.(test|vitest)\.tsx?$/.test(name))
    .map((name) => join(relative, name))
}

/**
 * The string literals and JSX text a screen renders.
 *
 * Extracted rather than scanned whole because the deictic words are forbidden
 * as LABELS, not as words: "Reach every workspace on this machine" is a
 * sentence about the machine and is fine, while a `"This machine"` a row
 * renders where a name belongs is the defect. A whole value is the difference.
 */
function renderedValues(source: string): string[] {
  const values: string[] = []
  for (const match of source.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`$\n]*)`/g)) {
    values.push(match[1] ?? match[2] ?? match[3] ?? "")
  }
  for (const match of source.matchAll(/>([^<>{}]+)</g)) values.push(match[1] ?? "")
  return values.map((value) => value.replace(/\s+/g, " ").trim())
}

describe("machine and workspace copy: the screens", () => {
  const screens = [...sourceFiles("features"), ...sourceFiles("app")]

  test("the walk reaches the screens it is meant to", () => {
    // A walk that found nothing would pass every assertion below.
    expect(screens.length).toBeGreaterThan(200)
    expect(screens).toContain("features/onboarding/remote-access-surface.tsx")
    expect(screens).toContain("app/workbench/rail/rail-sidebar.tsx")
    expect(screens).not.toContain("features/onboarding/remote-access-surface.vitest.tsx")
  })

  test("no screen names a workspace's type in prose", () => {
    const offenders = screens.flatMap((relative) => {
      const source = withoutComments(readFileSync(join(import.meta.dir, "../..", relative), "utf8"))
        .replace(/\s+/g, " ")
        .toLowerCase()
      return FORBIDDEN_PHRASES
        .filter((phrase) => phrase.includes(" "))
        .filter((phrase) => source.includes(phrase))
        .map((phrase) => `${relative}: ${phrase}`)
    })
    expect(offenders).toEqual([])
  })

  test("no screen labels anything with a word whose meaning moves with the reader", () => {
    const offenders = screens.flatMap((relative) => {
      const source = withoutComments(readFileSync(join(import.meta.dir, "../..", relative), "utf8"))
      return renderedValues(source)
        .filter((value) => FORBIDDEN_SCREEN_LABELS.includes(value.toLowerCase()))
        .map((value) => `${relative}: ${value}`)
    })
    expect(offenders).toEqual([])
  })

  test("every locale file in this directory is covered by the dictionary rule", async () => {
    const files = readdirSync(import.meta.dir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .filter((name) => !["locales.ts", "provider.tsx", "cloud-strings.ts", "en.ts"].includes(name))
      .map((name) => name.replace(/\.ts$/, ""))
    const covered = new Set(LOCALE_ENTRIES.map((entry) => (entry.code === "br" ? "pt-BR" : entry.code)))
    expect(files.filter((name) => !covered.has(name))).toEqual([])
  })
})
