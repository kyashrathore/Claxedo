$ErrorActionPreference = "Stop"

while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    # Assignment, never @(... $line | ConvertFrom-Json ...): on Windows
    # PowerShell 5.1 ConvertFrom-Json emits the JSON array as ONE pipeline
    # object, and wrapping it in @() nests it — @(@(pid)) — so the [int]
    # cast below throws InvalidCast on every query. A bare assignment stays
    # flat under both behaviors (5.1 single-object, 7 unrolled scalar); the
    # trailing @() then normalizes scalar-vs-array without ever nesting.
    $parsed = $line | ConvertFrom-Json
    $inputPids = @($parsed)
    if ($inputPids.Count -gt 512) {
      throw "too many process identifiers"
    }

    $pids = @(
      $inputPids |
        ForEach-Object { [int]$_ } |
        Where-Object { $_ -gt 0 } |
        Select-Object -Unique
    )
    if ($pids.Count -eq 0) {
      [Console]::Out.WriteLine('{"ok":true,"rows":[]}')
      continue
    }

    $filter = (($pids | ForEach-Object { "ProcessId = " + $_.ToString([Globalization.CultureInfo]::InvariantCulture) }) -join " OR ")
    $rows = @(
      Get-CimInstance -ClassName Win32_Process -Filter $filter -Property ProcessId,ParentProcessId,CreationDate,KernelModeTime,UserModeTime,WorkingSetSize |
        ForEach-Object {
          [ordered]@{
            pid = [int]$_.ProcessId
            ppid = [int]$_.ParentProcessId
            creationTicks = $_.CreationDate.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
            kernelTicks = ([uint64]$_.KernelModeTime).ToString([Globalization.CultureInfo]::InvariantCulture)
            userTicks = ([uint64]$_.UserModeTime).ToString([Globalization.CultureInfo]::InvariantCulture)
            rssBytes = ([uint64]$_.WorkingSetSize).ToString([Globalization.CultureInfo]::InvariantCulture)
          }
        }
    )
    [Console]::Out.WriteLine(([ordered]@{ ok = $true; rows = @($rows) } | ConvertTo-Json -Compress -Depth 3))
  } catch {
    # The exception MESSAGE only, and only ever the message: a caught CIM
    # error is the sole evidence of why a query failed on a machine we
    # cannot attach to, but the exception's other members reach process
    # state (command lines, environment) that must not cross the
    # diagnostics contract. Newlines are stripped so one failure stays one
    # protocol line, and the text is capped so a pathological message
    # cannot become the response.
    $reason = ([string]$_.Exception.Message) -replace '\s+', ' '
    if ($reason.Length -gt 200) { $reason = $reason.Substring(0, 200) }
    [Console]::Out.WriteLine(([ordered]@{ ok = $false; reason = $reason } | ConvertTo-Json -Compress -Depth 2))
  }
}
