param(
    [Parameter(Mandatory = $true)][string]$Stage,
    [switch]$StandardUser
)

$ErrorActionPreference = 'Stop'
$Stage = (Resolve-Path -LiteralPath $Stage).Path
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$administrators = 'S-1-5-32-544'

if ($StandardUser) {
    if ($identity.IsSystem -or ($identity.Groups.Value -contains $administrators)) {
        throw 'Native qualification requires a standard account, not an administrator.'
    }
    $env:USERPROFILE = [Environment]::GetFolderPath('UserProfile')
    $env:APPDATA = [Environment]::GetFolderPath('ApplicationData')
    $env:LOCALAPPDATA = [Environment]::GetFolderPath('LocalApplicationData')
    if (!$env:USERPROFILE -or !$env:APPDATA -or !$env:LOCALAPPDATA) {
        throw 'The standard account profile did not load.'
    }
    $volume = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($env:APPDATA))
    if ($volume.DriveType -ne [IO.DriveType]::Fixed -or $volume.DriveFormat -ne 'NTFS') {
        throw 'Native qualification requires an APPDATA profile on a fixed NTFS volume.'
    }
    $env:TEMP = $env:TMP = Join-Path $env:LOCALAPPDATA 'Temp'
    [void][IO.Directory]::CreateDirectory($env:TEMP)
    Set-Location -LiteralPath $env:USERPROFILE
    $env:OPENCODE_BIN = Join-Path $Stage 'opencode.exe'
    $env:PREDICTIONS_PACKAGE = Join-Path $Stage 'node_modules\opencode-predictions'
    Write-Host "Native Windows $([Environment]::OSVersion.Version); account is non-admin; volume is $($volume.DriveFormat)."
    & $env:OPENCODE_BIN --version
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & (Join-Path $Stage 'node.exe') --test (Join-Path $Stage 'tests\host\windows-preferences.test.ts')
    exit $LASTEXITCODE
}

$name = 'predtest-' + [Guid]::NewGuid().ToString('N').Substring(0, 10)
$password = ConvertTo-SecureString ('Aa1!' + [Guid]::NewGuid().ToString('N')) -AsPlainText -Force
$account = New-LocalUser -Name $name -Password $password
try {
    $users = Get-LocalGroup -SID 'S-1-5-32-545'
    if (!(Get-LocalGroupMember -Group $users | Where-Object { $_.SID -eq $account.SID })) {
        Add-LocalGroupMember -Group $users -Member $account
    }
    & (Join-Path ([Environment]::SystemDirectory) 'icacls.exe') $Stage /grant "*$($account.SID.Value):(OI)(CI)RX"
    if ($LASTEXITCODE -ne 0) { throw 'Could not grant the standard account access to the staged fixture.' }

    $launch = [Diagnostics.ProcessStartInfo]::new()
    $launch.FileName = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
    $launch.Arguments = '-NoLogo -NoProfile -NonInteractive -File "{0}" -Stage "{1}" -StandardUser' -f $PSCommandPath, $Stage
    $launch.WorkingDirectory = $Stage
    $launch.UserName = $name
    $launch.Domain = $env:COMPUTERNAME
    $launch.Password = $password
    $launch.LoadUserProfile = $true
    $launch.UseShellExecute = $false
    $launch.RedirectStandardOutput = $true
    $launch.RedirectStandardError = $true
    # Do not give the alternate account the CI process environment.
    $launch.EnvironmentVariables.Clear()
    foreach ($key in @('SystemRoot', 'SystemDrive', 'ComSpec', 'PATHEXT', 'COMPUTERNAME')) {
        $launch.EnvironmentVariables[$key] = [Environment]::GetEnvironmentVariable($key)
    }
    $launch.EnvironmentVariables['USERNAME'] = $name
    $launch.EnvironmentVariables['PATH'] = "$Stage;$([Environment]::SystemDirectory);$env:SystemRoot"

    $child = [Diagnostics.Process]::Start($launch)
    try {
        $stdout = $child.StandardOutput.ReadToEndAsync()
        $stderr = $child.StandardError.ReadToEndAsync()
        if (!$child.WaitForExit(300000)) {
            $child.Kill()
            throw 'The native Windows tests did not finish within 300 seconds.'
        }
        Write-Host ($stdout.GetAwaiter().GetResult())
        Write-Host ($stderr.GetAwaiter().GetResult())
        if ($child.ExitCode -ne 0) { throw "Native Windows tests exited with code $($child.ExitCode)." }
    } finally {
        $child.Dispose()
    }
} finally {
    Remove-LocalUser -SID $account.SID
}
