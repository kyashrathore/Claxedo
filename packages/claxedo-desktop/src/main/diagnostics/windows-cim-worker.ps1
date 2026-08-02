$ErrorActionPreference = "Stop"

while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $inputPids = @($line | ConvertFrom-Json)
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
    [Console]::Out.WriteLine('{"ok":false}')
  }
}
