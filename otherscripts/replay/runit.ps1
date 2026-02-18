param(
    [string]$LogFile = "D:\TradingScripts\history\signals\signals_log_sample.csv",
    [string]$OutDir = "D:\TradingScripts\history\signals\replay_output",
    [string]$StartDate = "2026-02-17",
    [string]$EndDate = "2026-02-17",
    [string]$Interval = "1m",
    [string]$EntryMode = "market",
    [string]$Dedupe = "none"
)

Write-Host ""
Write-Host "=== SIGNAL REPLAY RUNNER ===" -ForegroundColor Cyan
Write-Host "Log: $LogFile"
Write-Host "Output: $OutDir"
Write-Host "Dates: $StartDate -> $EndDate"
Write-Host ""

# Ensure output directory exists
if (!(Test-Path $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir | Out-Null
}

# Optional: activate venv if you use one
# Example:
# & "C:\Trading\venv\Scripts\Activate.ps1"

# Run python script
python replay_signals.py `
    --log "$LogFile" `
    --out "$OutDir" `
    --start-date "$StartDate" `
    --end-date "$EndDate" `
    --interval "$Interval" `
    --entry-mode "$EntryMode" `
    --dedupe "$Dedupe"

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Replay FAILED." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Replay completed successfully." -ForegroundColor Green
Write-Host ""
