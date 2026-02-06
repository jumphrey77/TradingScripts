# Get the current directory
#$basePath = "D:\TradingScripts\history\scans"
$basePath = "D:\TradingScripts\history\exports"

# Enumerate only CSV files in the current folder (no recursion)
Get-ChildItem -Path $basePath -Filter *.csv -File | ForEach-Object {

    # Format modified date as YYYY-MM-DD
    $dateFolder = $_.LastWriteTime.ToString("yyyy-MM-dd")

    # Full path to the destination folder
    $destPath = Join-Path $basePath $dateFolder

    # Create the folder if it doesn't exist
    if (-not (Test-Path $destPath)) {
        New-Item -Path $destPath -ItemType Directory | Out-Null
    }

    # Move the file into the dated folder
    # Test Move-Item -Path $_.FullName -Destination $destPath -WhatIf
    Move-Item -Path $_.FullName -Destination $destPath

}
