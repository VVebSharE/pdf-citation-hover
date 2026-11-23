# Removes the save helper registration created by install.ps1.
$hostName = 'com.pdfcitationhover.save'
Remove-Item -Path "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName" -Force -ErrorAction SilentlyContinue
foreach ($f in 'pdf_save_host.bat', "$hostName.json") {
    Remove-Item -Path (Join-Path $PSScriptRoot $f) -Force -ErrorAction SilentlyContinue
}
Write-Host 'Save helper removed.'
