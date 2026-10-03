# Installerar Aktieagenten i Windows Schemaläggaren.
# Kör så här (högerklicka i mappen -> Öppna i terminal):
#   powershell -ExecutionPolicy Bypass -File .\installera_schema.ps1

$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host "`n=== Aktieagent - installation ===`n" -ForegroundColor Cyan

# 1. Hitta Python
$py = $null
if (Get-Command py -ErrorAction SilentlyContinue) { $py = @("py", "-3") }
elseif (Get-Command python -ErrorAction SilentlyContinue) { $py = @("python") }
if (-not $py) {
    Write-Host "Hittar inte Python. Installera från python.org och kryssa i 'Add python.exe to PATH'." -ForegroundColor Red
    exit 1
}
$pyExe = $py[0]; $pyArgs = @($py | Select-Object -Skip 1)
Write-Host "[1/4] Python hittades: $(& $pyExe @pyArgs --version)"

# 2. Installera paket
Write-Host "[2/4] Installerar paket (kan ta en minut)..."
& $pyExe @pyArgs -m pip install --quiet --upgrade yfinance anthropic matplotlib pandas numpy lxml
if ($LASTEXITCODE -ne 0) { Write-Host "pip misslyckades." -ForegroundColor Red; exit 1 }

# 3. API-nyckel
$existing = [Environment]::GetEnvironmentVariable("ANTHROPIC_API_KEY", "User")
if ($existing) {
    Write-Host "[3/4] API-nyckel finns redan sparad."
} else {
    $secure = Read-Host "[3/4] Klistra in din API-nyckel från console.anthropic.com (syns inte när du skriver)" -AsSecureString
    $key = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    if (-not $key.StartsWith("sk-ant-")) { Write-Host "Nyckeln ser inte rätt ut (ska börja med sk-ant-)." -ForegroundColor Red; exit 1 }
    [Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", $key, "User")
    $env:ANTHROPIC_API_KEY = $key
    Write-Host "      Sparad för ditt Windows-konto."
}

# 4. Schemalagda körningar
Write-Host "[4/4] Lägger in i Schemaläggaren..."
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 3)
$tasks = @(
    @{ Name = "Aktieagent - bevakningslista"; Bat = "kor_bevakning.bat";
       Trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At "08:00" },
    # Startas dagligen, men screenern hoppar själv över om månadens ranking redan finns
    @{ Name = "Aktieagent - screener"; Bat = "kor_screener.bat";
       Trigger = New-ScheduledTaskTrigger -Daily -At "08:15" }
)
foreach ($t in $tasks) {
    $action = New-ScheduledTaskAction -Execute (Join-Path $dir $t.Bat) -WorkingDirectory $dir
    Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger $t.Trigger `
        -Settings $settings -Force | Out-Null
    Write-Host "      OK: $($t.Name)"
}

Write-Host "`nKlart!" -ForegroundColor Green
Write-Host "  Bevakningslistan körs varje måndag 08:00."
Write-Host "  Screenern körs en gång i månaden (första dagen datorn är på, 08:15)."
Write-Host "  Missas en tid (datorn avstängd) körs den när datorn startar igen."
Write-Host "  Rapporterna hamnar i: $dir\rapporter"
Write-Host "  Ändra aktier i: $dir\bevakningslista.txt`n"

$svar = Read-Host "Vill du provköra bevakningslistan nu? (j/n)"
if ($svar -eq "j") {
    Start-ScheduledTask -TaskName "Aktieagent - bevakningslista"
    Write-Host "Startad. Rapporten dyker upp i mappen rapporter om några minuter."
}
