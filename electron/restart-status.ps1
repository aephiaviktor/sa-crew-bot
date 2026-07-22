param(
    [Parameter(Mandatory = $true)][string]$AppName,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion,
    [Parameter(Mandatory = $true)][string]$AppRoot,
    [Parameter(Mandatory = $true)][string]$TaskName,
    [Parameter(Mandatory = $true)][string]$LogPath,
    [int]$SlowThresholdSeconds = 20,
    [int]$FailureThresholdSeconds = 90
)

$ErrorActionPreference = 'SilentlyContinue'
$startedAt = Get-Date
$normalizedRoot = [IO.Path]::GetFullPath($AppRoot).TrimEnd('\')

function Get-VisibleAppProcess {
    $candidates = Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" | Where-Object {
        $_.CommandLine -and $_.CommandLine.IndexOf($normalizedRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $_.CommandLine -notmatch '--type='
    }
    foreach ($candidate in $candidates) {
        $process = Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue
        if ($process -and $process.Responding -and $process.MainWindowHandle -ne 0) {
            return $process
        }
    }
    return $null
}

while (((Get-Date) - $startedAt).TotalSeconds -lt $SlowThresholdSeconds) {
    if (Get-VisibleAppProcess) { exit 0 }
    Start-Sleep -Milliseconds 500
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object Windows.Forms.Form
$form.Text = "$AppName restart"
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object Drawing.Size(470, 205)
$form.MinimumSize = $form.Size
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true

$title = New-Object Windows.Forms.Label
$title.Location = New-Object Drawing.Point(20, 18)
$title.Size = New-Object Drawing.Size(420, 28)
$title.Font = New-Object Drawing.Font('Segoe UI', 12, [Drawing.FontStyle]::Bold)
$title.Text = "$AppName is taking longer than expected to restart"
$form.Controls.Add($title)

$status = New-Object Windows.Forms.Label
$status.Location = New-Object Drawing.Point(20, 55)
$status.Size = New-Object Drawing.Size(420, 50)
$status.Font = New-Object Drawing.Font('Segoe UI', 9)
$form.Controls.Add($status)

$retry = New-Object Windows.Forms.Button
$retry.Location = New-Object Drawing.Point(20, 120)
$retry.Size = New-Object Drawing.Size(105, 32)
$retry.Text = 'Retry'
$retry.Add_Click({ Start-Process -FilePath 'schtasks.exe' -ArgumentList @('/Run', '/TN', $TaskName) -WindowStyle Hidden })
$form.Controls.Add($retry)

$openLog = New-Object Windows.Forms.Button
$openLog.Location = New-Object Drawing.Point(135, 120)
$openLog.Size = New-Object Drawing.Size(105, 32)
$openLog.Text = 'Open log'
$openLog.Add_Click({
    if (Test-Path $LogPath) { Start-Process -FilePath 'notepad.exe' -ArgumentList @($LogPath) }
})
$form.Controls.Add($openLog)

$close = New-Object Windows.Forms.Button
$close.Location = New-Object Drawing.Point(335, 120)
$close.Size = New-Object Drawing.Size(105, 32)
$close.Text = 'Close'
$close.Add_Click({ $form.Close() })
$form.Controls.Add($close)

$timer = New-Object Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
    if (Get-VisibleAppProcess) {
        $timer.Stop()
        $form.Close()
        return
    }
    $elapsed = [Math]::Floor(((Get-Date) - $startedAt).TotalSeconds)
    if ($elapsed -ge $FailureThresholdSeconds) {
        $title.Text = "$AppName could not restart"
        $status.Text = "Expected version $ExpectedVersion. No visible, responding app window appeared after $elapsed seconds."
    } else {
        $status.Text = "Waiting for version $ExpectedVersion to open... ($elapsed seconds)"
    }
})
$timer.Start()
[void]$form.ShowDialog()
$timer.Stop()
