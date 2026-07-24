import { resolve } from "node:path"
import ts from "typescript-legacy"

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
      findForbiddenDiagnosticsFields(
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

export function findForbiddenDiagnosticsFields(
  source: string,
  file = "fixture.ts",
  scopes?: readonly string[],
) {
  const syntax = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, syntax)
  const findings: Array<{ file: string; field: string }> = []

  const inspect = (node: ts.Node) => {
    if (
      ts.isPropertySignature(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertyAssignment(node) ||
      ts.isMethodSignature(node) ||
      ts.isMethodDeclaration(node)
    ) {
      const field = propertyName(node.name)
      if (field && forbiddenFields.has(field.toLowerCase())) findings.push({ file, field })
    }
    ts.forEachChild(node, inspect)
  }

  if (!scopes) {
    inspect(parsed)
    return findings
  }
  const visitScopes = (node: ts.Node) => {
    if (declarationName(node) && scopes.includes(declarationName(node)!)) {
      inspect(node)
      return
    }
    ts.forEachChild(node, visitScopes)
  }
  visitScopes(parsed)
  return findings
}

function declarationName(node: ts.Node) {
  if (
    ts.isVariableDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isModuleDeclaration(node)
  ) {
    return propertyName(node.name)
  }
}

function propertyName(name: ts.PropertyName | ts.BindingName | ts.ModuleName | undefined) {
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
