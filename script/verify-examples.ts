const examples = [
  {
    dir: "examples/local-single-user",
    packageImports: ["@claxedo/server"],
  },
  {
    dir: "examples/hosted-team",
    packageImports: ["@claxedo/server"],
  },
  {
    dir: "examples/runtime-only-host",
    packageImports: ["@claxedo/workspace-runtime"],
    forbiddenImports: ["@claxedo/server"],
  },
  {
    dir: "examples/headless-client",
    packageImports: ["@claxedo/server"],
  },
  {
    dir: "examples/extension-client",
    packageImports: ["@claxedo/agent-extensions"],
    forbiddenImports: ["@claxedo/server"],
  },
] as const

function fail(message: string): never {
  console.error(`[examples] ${message}`)
  process.exit(1)
}

async function json(path: string) {
  return await Bun.file(path).json() as Record<string, unknown>
}

async function sourceFiles(dir: string) {
  const proc = Bun.spawn(["find", `${dir}/src`, "-type", "f", "-name", "*.ts"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) fail(`failed to list ${dir}/src: ${stderr.trim()}`)
  return stdout.split("\n").filter((item) => item.trim())
}

async function assertRootWorkspaceIncludesExamples() {
  const root = await json("package.json")
  const workspaces = root.workspaces && typeof root.workspaces === "object"
    ? root.workspaces as { packages?: unknown }
    : undefined
  const packages = Array.isArray(workspaces?.packages) ? workspaces.packages : []
  if (!packages.includes("examples/*")) {
    fail("root package.json workspaces must include examples/*")
  }
}

async function assertExampleShape(example: (typeof examples)[number]) {
  const pkg = await json(`${example.dir}/package.json`)
  const scripts = pkg.scripts && typeof pkg.scripts === "object"
    ? pkg.scripts as Record<string, unknown>
    : {}
  if (
    scripts.typecheck !== "tsc --noEmit -p tsconfig.json"
  ) {
    fail(`${example.dir} must expose the standard typecheck script`)
  }
  if (example.packageImports.length === 0) fail(`${example.dir} must consume at least one Claxedo package`)
  const config = await Bun.file(`${example.dir}/tsconfig.json`).text()
  if (config.includes("../types") || config.includes("examples/types") || config.includes("tsconfig.typecheck")) {
    fail(`${example.dir} must typecheck against package exports, not example-local type stubs`)
  }
  const files = await sourceFiles(example.dir)
  if (files.length === 0) fail(`${example.dir} has no TypeScript source files`)

  const text = (await Promise.all(files.map((file) => Bun.file(file).text()))).join("\n")
  if (text.includes("claxedo-app") || text.includes("packages/claxedo-app")) {
    fail(`${example.dir} imports claxedo-app internals`)
  }
  for (const item of example.packageImports) {
    if (!text.includes(`"${item}"`) && !text.includes(`'${item}'`)) {
      fail(`${example.dir} must import ${item} through its package entrypoint`)
    }
  }
  for (const item of "forbiddenImports" in example ? example.forbiddenImports ?? [] : []) {
    if (text.includes(`"${item}"`) || text.includes(`'${item}'`)) {
      fail(`${example.dir} must not import ${item}`)
    }
  }
}

async function runTypecheck(dir: string) {
  console.log(`[examples] typecheck ${dir}`)
  const proc = Bun.spawn(["bun", "run", "typecheck"], {
    cwd: dir,
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await proc.exited
  if (code !== 0) fail(`${dir} typecheck failed`)
}

await assertRootWorkspaceIncludesExamples()
for (const example of examples) {
  await assertExampleShape(example)
}
for (const example of examples) {
  await runTypecheck(example.dir)
}
console.log("[examples] ok")
