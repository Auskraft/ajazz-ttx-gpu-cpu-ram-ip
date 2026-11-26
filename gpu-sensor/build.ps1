param(
    [string]$SensorDist = (Join-Path $PSScriptRoot '../cpu-sensor/dist'),
    [string]$Destination = (Join-Path $PSScriptRoot 'dist')
)

$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$library = Join-Path $SensorDist 'LibreHardwareMonitorLib.dll'
if (!(Test-Path -LiteralPath $library)) { throw 'Build the CPU sensor dependencies first.' }

New-Item -Path $Destination -ItemType Directory -Force | Out-Null
Copy-Item -Path (Join-Path $SensorDist '*.dll') -Destination $Destination -Force
Copy-Item -LiteralPath (Join-Path $SensorDist 'licenses') -Destination $Destination -Recurse -Force
$output = Join-Path $Destination 'GpuHotspot.exe'
$source = Join-Path $PSScriptRoot 'GpuHotspot.cs'
& $compiler /nologo /target:exe /platform:x64 /optimize+ "/out:$output" "/reference:$library" $source
if ($LASTEXITCODE -ne 0) { throw "Failed to compile GPU Hot Spot helper ($LASTEXITCODE)." }
