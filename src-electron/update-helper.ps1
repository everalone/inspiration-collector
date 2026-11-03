param([Parameter(Mandatory=$true)][string]$PlanPath)
$ErrorActionPreference = 'Stop'
$plan = $null
$backupPath = $null
$replaced = $false
function Write-UpdateStatus([string]$phase, [string]$code = '') {
  $statusPath = Join-Path $plan.planDir 'status.json'
  @{phase=$phase; code=$code} | ConvertTo-Json -Compress | Set-Content -LiteralPath ($statusPath + '.tmp') -Encoding utf8
  Move-Item -LiteralPath ($statusPath + '.tmp') -Destination $statusPath -Force
}
function Assert-File([string]$file) {
  $item = Get-Item -LiteralPath $file
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'invalid_file' }
}
function Assert-Hash([string]$file) {
  Assert-File $file
  $stream = [IO.File]::OpenRead($file)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { $digest = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose(); $stream.Dispose() }
  if ((Get-Item -LiteralPath $file).Length -ne $plan.size -or $digest -ne $plan.sha256) { throw 'integrity' }
}
function Is-Cancelled { return Test-Path -LiteralPath (Join-Path $plan.planDir 'cancelled') }
try {
  $plan = Get-Content -LiteralPath $PlanPath -Raw -Encoding utf8 | ConvertFrom-Json
  if ($plan.version -ne 1 -or $plan.kind -notin @('portable','setup') -or $plan.sha256 -notmatch '^[0-9a-f]{64}$' -or $plan.size -lt 2 -or $plan.size -gt 536870912) { throw 'invalid_plan' }
  $plan.planDir = [IO.Path]::GetFullPath($plan.planDir)
  if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($PlanPath)) -ne $plan.planDir) { throw 'invalid_plan' }
  $plan.source = [IO.Path]::GetFullPath($plan.source)
  $plan.target = [IO.Path]::GetFullPath($plan.target)
  if ([IO.Path]::GetExtension($plan.target) -ne '.exe' -or $plan.target -eq $plan.source -or $plan.target -match '[\r\n"]') { throw 'invalid_plan' }
  Assert-File $plan.target
  Assert-Hash $plan.source
  $targetDirectory = [IO.Path]::GetDirectoryName($plan.target)
  $modeFlag = ''
  if ($plan.kind -eq 'setup') {
    # electron-builder v26 derives this GUID from the fixed appId, not the display name.
    $registrySuffix = 'Software\a02c56a7-dcab-56a4-a309-a8dafb5288a3'
    $matchingModes = @()
    foreach ($hive in @('HKCU','HKLM')) {
      $key = $hive + ':\' + $registrySuffix
      $location = (Get-ItemProperty -LiteralPath $key -Name InstallLocation -ErrorAction SilentlyContinue).InstallLocation
      if ($location -and [IO.Path]::GetFullPath($location).TrimEnd('\') -eq $targetDirectory.TrimEnd('\')) { $matchingModes += $hive }
    }
    if ($matchingModes.Count -ne 1) { throw 'layout' }
    $modeFlag = if ($matchingModes[0] -eq 'HKLM') { '/allusers' } else { '/currentuser' }
  } else {
    $probe = Join-Path $targetDirectory ('.inspiration-update-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($probe, 'probe')
    Remove-Item -LiteralPath $probe
  }
  # Capture process objects before authorization, avoiding PID-reuse waits.
  $oldProcess = Get-Process -Id $plan.processId -ErrorAction SilentlyContinue
  if (!$oldProcess) { throw 'process_missing' }
  [void]$oldProcess.Handle
  $launcher = $null
  if ($plan.kind -eq 'portable' -and $plan.launcherPid) {
    $candidateLauncher = Get-Process -Id $plan.launcherPid -ErrorAction SilentlyContinue
    if ($candidateLauncher -and $candidateLauncher.Path -eq $plan.target) { $launcher = $candidateLauncher; [void]$launcher.Handle }
  }
  Write-UpdateStatus 'ready'
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while (!(Test-Path -LiteralPath (Join-Path $plan.planDir 'authorized'))) {
    if ((Is-Cancelled) -or [DateTime]::UtcNow -gt $deadline) { throw 'cancelled' }
    Start-Sleep -Milliseconds 100
  }
  if (Is-Cancelled) { throw 'cancelled' }
  if (!$oldProcess.WaitForExit(90000)) { throw 'process_busy' }
  if ($launcher -and !$launcher.WaitForExit(90000)) { throw 'process_busy' }
  if (Is-Cancelled) { throw 'cancelled' }
  Assert-Hash $plan.source
  if ($plan.kind -eq 'portable') {
    $stagedPath = Join-Path $targetDirectory ('.inspiration-update-' + [Guid]::NewGuid().ToString('N') + '.exe')
    $backupPath = $plan.target + '.previous-' + [Guid]::NewGuid().ToString('N') + '.exe'
    Copy-Item -LiteralPath $plan.source -Destination $stagedPath
    Assert-Hash $stagedPath
    # File.Replace keeps a recoverable copy and swaps within the original filesystem.
    [IO.File]::Replace($stagedPath, $plan.target, $backupPath)
    $replaced = $true
    Assert-Hash $plan.target
    Start-Process -FilePath $plan.target -ArgumentList '--updated' -WorkingDirectory $targetDirectory -WindowStyle Hidden
  } else {
    # /D must be the final unquoted NSIS parameter, even when the path has spaces.
    $arguments = '/S --updated ' + $modeFlag + ' /D=' + $targetDirectory
    if ($modeFlag -eq '/allusers') {
      $installer = Start-Process -FilePath $plan.source -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    } else {
      $installer = Start-Process -FilePath $plan.source -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
    }
    if ($installer.ExitCode -ne 0) { throw 'installer_failed' }
    if (!(Test-Path -LiteralPath $plan.target)) { throw 'installer_failed' }
    Start-Process -FilePath $plan.target -ArgumentList '--updated' -WorkingDirectory $targetDirectory -WindowStyle Hidden
  }
  Write-UpdateStatus 'done'
} catch {
  if ($plan) {
    if ($replaced -and $backupPath -and (Test-Path -LiteralPath $backupPath)) {
      # PowerShell coerces a null backup-name argument into an empty path; keep the rejected file separately.
      $rejectedPath = $plan.target + '.rejected-' + [Guid]::NewGuid().ToString('N') + '.exe'
      for ($restoreAttempt = 0; $restoreAttempt -lt 10; $restoreAttempt++) {
        try { [IO.File]::Replace($backupPath, $plan.target, $rejectedPath); break }
        catch { Start-Sleep -Milliseconds 100 }
      }
    }
    $code = if ($_.Exception.Message -eq 'layout') { 'layout' } else { 'install_failed' }
    try { Write-UpdateStatus 'error' $code } catch { }
    # If the old process exited, restore its availability after an install failure.
    if ($oldProcess -and $oldProcess.HasExited -and (Test-Path -LiteralPath $plan.target)) {
      try { Start-Process -FilePath $plan.target -WorkingDirectory ([IO.Path]::GetDirectoryName($plan.target)) -WindowStyle Hidden } catch { }
    }
  }
  exit 1
}
