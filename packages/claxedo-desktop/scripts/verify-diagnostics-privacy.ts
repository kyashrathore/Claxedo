import { resolve } from "node:path"
// Type-only at module scope: typescript-legacy is an 8.7MB single-file module,
// and this script sits in the desktop unit lane's test graph — loading it at
// import time taxes every test run for a compiler only the scan below uses.
import type TS from "typescript-legacy"

type TsModule = typeof TS
let tsModule: Promise<TsModule> | undefined
function loadTs(): Promise<TsModule> {
  tsModule ??= import("typescript-legacy").then((mod) => mod.default)
  return tsModule
}

const diagnosticsBoundaryFiles = [
  {
    file: "packages/claxedo-app/src/features/processes/data/local-diagnostics.ts",
    scopes: ["LocalDiagnostics"],
  },
  {
    file: "packages/claxedo-desktop/src/shared/diagnostics-transport.ts",
    scopes: undefined,
  },
  {
    file: "packages/claxedo-desktop/src/preload/index.ts",
    scopes: ["processDiagnosticsBridge"],
  },
  {
    file: "packages/claxedo-desktop/src/preload/types.ts",
    scopes: ["ProcessDiagnosticsBridge"],
  },
  {
    file: "packages/claxedo-desktop/scripts/performance-diagnostics-smoke.ts",
    scopes: ["DiagnosticsSmokeEvidence"],
  },
] as const

const forbiddenFields = new Set([
  "args",
  "arguments",
  "argv",
  "auth",
  "authtoken",
  "command",
  "commandline",
  "config",
  "credential",
  "credentials",
  "env",
  "environment",
  "executablepath",
  "header",
  "headers",
  "prompt",
  "rawcommand",
  "shell",
  "shellcommand",
  "shelltext",
])

export async function verifyDiagnosticsPrivacy(root = resolve(import.meta.dirname, "../../..")) {
  const findings = (
    await Promise.all(diagnosticsBoundaryFiles.map(async (boundary) =>
      await findForbiddenDiagnosticsFields(
        await Bun.file(resolve(root, boundary.file)).text(),
        boundary.file,
        boundary.scopes,
      ),
    ))
  ).flat()
  const legacy = await Promise.all([
    "packages/workspace-runtime/src/routes/process.ts",
    "packages/claxedo-app/src/features/processes/data/client.ts",
  ].map(async (file) => ({
    file,
    source: await Bun.file(resolve(root, file)).text(),
  })))
  legacy.forEach(({ file, source }) => {
    if (/diagnostics(?:\/terminate)?/.test(source)) findings.push({ file, field: "legacy-diagnostics-route" })
  })
  return {
    files: diagnosticsBoundaryFiles.map((boundary) => boundary.file),
    findings,
  }
}

export async function findForbiddenDiagnosticsFields(
  source: string,
  file = "fixture.ts",
  scopes?: readonly string[],
) {
  const ts = await loadTs()
  const syntax = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, syntax)
  const findings: Array<{ file: string; field: string }> = []

  const inspect = (node: TS.Node) => {
    if (
      ts.isPropertySignature(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertyAssignment(node) ||
      ts.isMethodSignature(node) ||
      ts.isMethodDeclaration(node)
    ) {
      const field = propertyName(ts, node.name)
      if (field && forbiddenFields.has(field.toLowerCase())) findings.push({ file, field })
    }
    ts.forEachChild(node, inspect)
  }

  if (!scopes) {
    inspect(parsed)
    return findings
  }
  const visitScopes = (node: TS.Node) => {
    if (declarationName(ts, node) && scopes.includes(declarationName(ts, node)!)) {
      inspect(node)
      return
    }
    ts.forEachChild(node, visitScopes)
  }
  visitScopes(parsed)
  return findings
}

function declarationName(ts: TsModule, node: TS.Node) {
  if (
    ts.isVariableDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isModuleDeclaration(node)
  ) {
    return propertyName(ts, node.name)
  }
}

function propertyName(ts: TsModule, name: TS.PropertyName | TS.BindingName | TS.ModuleName | undefined) {
  if (!name) return
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text
  }
}

if (import.meta.main) {
  const report = await verifyDiagnosticsPrivacy()
  console.log(JSON.stringify(report, null, 2))
  if (report.findings.length > 0) process.exit(1)
}
