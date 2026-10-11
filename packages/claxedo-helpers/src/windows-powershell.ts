import { join } from "node:path"

/** Absolute, so `PATH` cannot decide which interpreter runs. */
export function powershellPath() {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

/**
 * A PowerShell command that resolves no cmdlet, `New-Object` included: it
 * calls .NET directly and writes through `[Console]`. Resolving a cmdlet makes
 * PowerShell discover modules across `PSModulePath`, which under the minimal
 * environment these commands run with took 12 to 23 s per start on GitHub's
 * windows-latest image, with Az installed, against 150 ms without one.
 *
 * A failure reaches stderr as its innermost .NET message: a throw arrives
 * wrapped, reflection adds a layer, and the wrappers' messages say nothing
 * useful.
 */
export function cmdletFreeCommand(body: string) {
  return (
    "$ErrorActionPreference = 'Stop'; try { " +
    body +
    " } catch { $reason = $_.Exception; while ($reason.InnerException) { $reason = $reason.InnerException }; " +
    "[Console]::Error.WriteLine($reason.Message); exit 1 }"
  )
}

/**
 * A cmdlet-free command that compiles the C# 5 source held in the environment
 * variable `sourceVariable` through CodeDom and runs `typeName.Serve()`. The
 * source travels in the environment because a command line is capped at 32,767
 * characters.
 */
export function compiledProgramCommand(sourceVariable: string, typeName: string) {
  // One line, separators included: a missing `;` here is a parse error that
  // reaches the caller as a program that exited before serving.
  return cmdletFreeCommand(
    "$options = [System.CodeDom.Compiler.CompilerParameters]::new([string[]] @('System.dll')); " +
    "$options.GenerateInMemory = $true; " +
    "$compiled = [Microsoft.CSharp.CSharpCodeProvider]::new().CompileAssemblyFromSource(" +
    `$options, [Environment]::GetEnvironmentVariable('${sourceVariable}')); ` +
    "if ($compiled.Errors.HasErrors) { " +
    `$failure = '${typeName} did not compile:'; ` +
    "foreach ($problem in $compiled.Errors) { if (-not $problem.IsWarning) { $failure += ' ' + $problem.ToString() } }; " +
    "throw $failure }; " +
    `$compiled.CompiledAssembly.GetType('${typeName}').GetMethod('Serve').Invoke($null, $null)`,
  )
}
