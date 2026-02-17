<#
Split-CSVsByTicker.ps1

Usage:
  .\Split-CSVsByTicker.ps1 -InputDir "C:\path\to\scans" -OutputDir "C:\path\to\out"

Notes:
- Auto-detects delimiter per file: TAB if header contains a tab, else comma.
- Preserves the original line text when appending (so formatting stays the same).
- Writes header once per ticker file (when created).
#>

[CmdletBinding(SupportsShouldProcess=$true)]
param(
  [Parameter(Mandatory = $true)]
  [string]$InputDir,

  [Parameter(Mandatory = $false)]
  [string]$OutputDir = (Join-Path $InputDir "by_ticker"),

  [switch]$Recurse
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $InputDir)) {
  throw "InputDir not found: $InputDir"
}

if (-not (Test-Path -LiteralPath $OutputDir)) {
  New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

# Track which ticker output files we've initialized (header written)
$initialized = @{}

# Gather CSV files
$csvFiles =
  if ($Recurse) {
    Get-ChildItem -LiteralPath $InputDir -Filter *.csv -File -Recurse
  } else {
    Get-ChildItem -LiteralPath $InputDir -Filter *.csv -File
  }

foreach ($f in $csvFiles) {
  # Read all lines (fast and simple; OK for moderate file sizes)
  $lines = Get-Content -LiteralPath $f.FullName

  if (-not $lines -or $lines.Count -lt 2) { continue }  # no data

  $header = $lines[0]
  if ([string]::IsNullOrWhiteSpace($header)) { continue }

  # Auto-detect delimiter for THIS file
  $delim = if ($header.Contains("`t")) { "`t" } else { "," }

  # Process each data line (skip header)
  for ($i = 1; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    # Split just enough to get column 1 (ticker)
    # (Using -split with a max of 2 keeps it cheap.)
    $parts = $line -split [regex]::Escape($delim), 2
    if ($parts.Count -lt 1) { continue }

    $ticker = if ($parts.Count -gt 0) { ($parts[0] -as [string]).Trim() } else { "" }

    if ([string]::IsNullOrWhiteSpace($ticker)) { continue }

    # Sanitize ticker for a safe filename (keep letters/numbers/._-)
    $safeTicker = ($ticker -replace '[^\w\.\-]', '_')
    $outPath = Join-Path $OutputDir ($safeTicker + ".csv")

    # If new output file, write header once
    if (-not $initialized.ContainsKey($outPath)) {
      if (-not (Test-Path -LiteralPath $outPath)) {
        # Create file + write header
        Set-Content -LiteralPath $outPath -Value $header -Encoding UTF8
      } else {
        # File exists already; ensure it has a header (if empty, add header)
        $firstLine = (Get-Content -LiteralPath $outPath -TotalCount 1 -ErrorAction SilentlyContinue)
        if ([string]::IsNullOrWhiteSpace($firstLine)) {
          Set-Content -LiteralPath $outPath -Value $header -Encoding UTF8
        }
      }
      $initialized[$outPath] = $true
    }

    # Append the original line exactly as-is
    Add-Content -LiteralPath $outPath -Value $line -Encoding UTF8
  }
}

Write-Host "Done. Output written to: $OutputDir"
