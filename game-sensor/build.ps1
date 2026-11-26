param([string]$Destination = (Join-Path $PSScriptRoot 'dist'))

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $Destination -Force | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$source = @(
    (Join-Path $PSScriptRoot 'GameSensor.cs'),
    (Join-Path $PSScriptRoot 'Microphone.cs')
)
$binary = Join-Path $Destination 'GameSensor.exe'
& $compiler /nologo /target:exe /platform:x64 /codepage:65001 /optimize+ /reference:System.Management.dll /reference:System.Web.Extensions.dll "/out:$binary" $source
if ($LASTEXITCODE -ne 0) { throw "Game sensor compilation failed ($LASTEXITCODE)." }
