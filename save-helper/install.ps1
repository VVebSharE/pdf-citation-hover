# Installs the save helper so PDF Citation Hover can save PDFs in place.
# Run:  powershell -ExecutionPolicy Bypass -File install.ps1
# Undo: powershell -ExecutionPolicy Bypass -File uninstall.ps1

$ErrorActionPreference = 'Stop'
$hostName = 'com.pdfcitationhover.save'
$extensionId = 'inbjmfbclghfmkioeifjgfcgaigggfhk'
$dir = $PSScriptRoot

# Find Python (needed to run pdf_save_host.py).
$python = $null
foreach ($cmd in 'python', 'py') {
    $c = Get-Command $cmd -ErrorAction SilentlyContinue
    if ($c) {
        $exe = & $c.Source -c "import sys; print(sys.executable)" 2>$null
        if ($LASTEXITCODE -eq 0 -and $exe) { $python = $exe.Trim(); break }
    }
}
if (-not $python) { throw 'Python 3 was not found. Install it from python.org and run this again.' }

# Launcher that Edge starts.
$bat = Join-Path $dir 'pdf_save_host.bat'
Set-Content -Path $bat -Encoding ASCII -Value "@echo off`r`n`"$python`" -u `"%~dp0pdf_save_host.py`" %*"

# Host manifest.
$manifestPath = Join-Path $dir "$hostName.json"
$manifest = [ordered]@{
    name            = $hostName
    description     = 'Saves PDFs for the PDF Citation Hover extension'
    path            = $bat
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$extensionId/")
}
$manifest | ConvertTo-Json | Set-Content -Path $manifestPath -Encoding UTF8

# Register it with Edge (current user only).
$key = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
New-Item -Path $key -Force | Out-Null
Set-Item -Path $key -Value $manifestPath

Write-Host "Save helper installed (Python: $python)."
Write-Host 'Reload the extension in edge://extensions, then Save will write PDFs back to their original location.'
