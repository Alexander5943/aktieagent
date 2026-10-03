# Tar bort Aktieagentens schemalagda körningar.
# Kör: powershell -ExecutionPolicy Bypass -File .\avinstallera_schema.ps1
foreach ($n in @("Aktieagent - bevakningslista", "Aktieagent - screener")) {
    Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Borttagen: $n"
}
Write-Host "API-nyckeln ligger kvar. Ta bort den med:"
Write-Host '  [Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", $null, "User")'
