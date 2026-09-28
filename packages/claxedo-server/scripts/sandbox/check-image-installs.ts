import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const sources = [path.join(here, "Dockerfile"), path.join(here, "cloudflare-worker/Dockerfile"), path.join(here, "install-agent-artifacts.sh")]

function commands(source: string) {
  return source.replace(/\\\n/g, " ").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
}

function hasExactPackage(token: string) {
  return /^(?:@[^/\s]+\/)?[^@\s]+@\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(token)
}

export function imageInstallErrors(source: string) {
  const errors: string[] = []
  const lines = commands(source)
  const content = lines.join("\n")
  if (/\blatest\b/i.test(content)) errors.push("mutable latest reference")
  if (/\b(?:curl|wget)\b[^\n|]*\|\s*(?:\/bin\/)?(?:ba)?sh\b/.test(content)) errors.push("remote installer piped to a shell")
  if (/\bwget\b/.test(content)) errors.push("wget download")
  if (/^ADD\s+(?:--\S+\s+)*https?:\/\//m.test(content)) errors.push("remote ADD")

  for (const match of content.matchAll(/\bnpm\s+([^\n;&|]+)/g)) {
    const arg = match[1].trim()
    if (!/(?:^|\s)(?:i|install)(?:\s|$)/.test(arg) || !/(?:^|\s)(?:-g|--global)(?:\s|$)/.test(arg)) continue
    const variables = [...arg.matchAll(/\$\{(\w+)\}/g)].map((item) => item[1])
    const literals = arg.replace(/\$\{\w+\}/g, "").replace(/(?:^|\s)(?:i|install)(?=\s|$)/, " ").split(/\s+/)
      .filter((token) => token && !token.startsWith("-"))
    for (const variable of variables) {
      const value = content.match(new RegExp(`\\bARG\\s+${variable}="([^"]+)"`))?.[1]
      if (!value) errors.push(`npm global install: ${variable} has no literal package list`)
      else literals.push(...value.split(/\s+/))
    }
    for (const token of literals) if (!hasExactPackage(token)) errors.push(`npm global install: unpinned package ${token}`)
  }

  const digestAssignments = [...content.matchAll(/\b([A-Za-z_]\w*sha256)=([^\s;]+)/g)]
  const digestVariables = new Set(digestAssignments.map((item) => item[1]))
  for (const assignment of digestAssignments) {
    if (!/^[a-f0-9]{64}$/.test(assignment[2])) errors.push(`SHA-256 is not literal: ${assignment[1]}`)
  }
  for (const line of lines) {
    for (const segment of line.split(/&&|;/)) {
      const url = segment.trim().replace(/^(?:RUN|then)\s+/, "")
      if (!/^curl\s/.test(url)) continue
      const target = url.match(/\s-o\s+(\/[^\s;]+)/)?.[1]
      if (!target) {
        errors.push(`download is not written to a file: ${url}`)
        continue
      }
      const versionVariables = [...url.matchAll(/\$\{(\w*version)\}/g)].map((item) => item[1])
      if (!versionVariables.length && !/\/v?\d+\.\d+\.\d+(?:[-/]|$)/.test(url)) errors.push(`download has no version: ${target}`)
      for (const variable of versionVariables) {
        const values = [...content.matchAll(new RegExp(`\\b${variable}=([^\\s;]+)`, "g"))].map((item) => item[1])
        if (values.length !== 1 || !/^\d[\w.-]*$/.test(values[0])) errors.push(`download version is not literal: ${variable}`)
      }
      const download = content.indexOf(url)
      const checks = [...content.matchAll(/printf\s+[^\n]*?\s+"?(\$[A-Za-z_]\w*|[a-f0-9]{64})"?\s+(\/[^\s;]+)\s*\|\s*sha256sum\s+-c\s+-/g)]
      const check = checks.find((item) => item[2] === target && item.index > download && (item[1].startsWith("$") ? digestVariables.has(item[1].slice(1)) : /^[a-f0-9]{64}$/.test(item[1])))
      if (!check) errors.push(`download lacks literal SHA-256 check: ${target}`)
      else {
        const between = content.slice(download + url.length, check.index)
        if (between.includes(target)) errors.push(`download used before SHA-256 check: ${target}`)
      }
    }
  }
  return errors
}

export function checkSandboxImageInstalls(files: string[] = sources) {
  const errors = files.flatMap((file) => imageInstallErrors(fs.readFileSync(file, "utf8")).map((error) => `${file}: ${error}`))
  if (files.length === sources.length) {
    for (const file of sources.slice(0, 2)) {
      const source = fs.readFileSync(file, "utf8")
      if (!source.includes("COPY .build/install-agent-artifacts.sh") || !source.includes("sh /tmp/install-agent-artifacts.sh")) {
        errors.push(`${file}: shared agent installer is not run`)
      }
    }
  }
  return errors
}

if (import.meta.main) {
  const errors = checkSandboxImageInstalls(process.argv.length > 2 ? process.argv.slice(2) : sources)
  if (errors.length) {
    console.error(errors.join("\n"))
    process.exitCode = 1
  }
}
