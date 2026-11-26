param(
    [string]$OutDir = (Join-Path $PSScriptRoot '../dist'),
    [string]$PawnIoInstaller,
    [switch]$ReuseSensor
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$pluginName = 'com.auskraft.ajazz.ttx.sdPlugin'
$pluginSource = Join-Path $root "plugin/$pluginName"
$cpuSource = Join-Path $root 'cpu-sensor'
$sensorDist = Join-Path $cpuSource 'dist'
if (!$ReuseSensor) {
    & (Join-Path $cpuSource 'build.ps1')
}
if (!(Test-Path -LiteralPath (Join-Path $sensorDist 'CpuSensor.exe'))) {
    throw 'Build the CPU sensor first or omit -ReuseSensor.'
}

New-Item -Path $OutDir -ItemType Directory -Force | Out-Null
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path
if (!$PawnIoInstaller) {
    $downloadDir = Join-Path $OutDir 'dependencies'
    New-Item -Path $downloadDir -ItemType Directory -Force | Out-Null
    $PawnIoInstaller = Join-Path $downloadDir 'PawnIO_setup.exe'
    if (!(Test-Path -LiteralPath $PawnIoInstaller)) {
        $pawnUri = 'https://github.com/namazso/PawnIO.Setup/releases/download/2.2.0/PawnIO_setup.exe'
        Invoke-WebRequest -UseBasicParsing -Uri $pawnUri -OutFile $PawnIoInstaller
    }
}
$expectedHash = '1F519A22E47187F70A1379A48CA604981C4FCF694F4E65B734AAA74A9FBA3032'
if ((Get-FileHash -LiteralPath $PawnIoInstaller -Algorithm SHA256).Hash -ne $expectedHash) {
    throw 'PawnIO setup checksum did not match version 2.2.0.'
}
if ((Get-AuthenticodeSignature -LiteralPath $PawnIoInstaller).Status -ne 'Valid') {
    throw 'PawnIO setup signature could not be validated.'
}

$staging = Join-Path $OutDir ('build-' + [Guid]::NewGuid().ToString('N'))
$archiveRoot = Join-Path $staging 'plugin'
$pluginStage = Join-Path $archiveRoot $pluginName
$payload = Join-Path $staging 'payload'
$payloadCpu = Join-Path $payload 'cpu'
New-Item -Path $archiveRoot,$payloadCpu -ItemType Directory -Force | Out-Null
Copy-Item -LiteralPath $pluginSource -Destination $pluginStage -Recurse
Copy-Item -LiteralPath (Join-Path $cpuSource 'cpu-temperature.cjs') -Destination $pluginStage
Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination $pluginStage
Copy-Item -LiteralPath (Join-Path $root 'README.md') -Destination $pluginStage
Copy-Item -Path (Join-Path $sensorDist '*') -Destination $payloadCpu -Recurse
Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination $payload
Copy-Item -LiteralPath $PawnIoInstaller -Destination (Join-Path $payload 'PawnIO_setup.exe')

Add-Type -AssemblyName System.IO.Compression.FileSystem
$pluginZip = Join-Path $payload $pluginName
[IO.Compression.ZipFile]::CreateFromDirectory($archiveRoot,$pluginZip)
$payloadZip = Join-Path $staging 'payload.zip'
[IO.Compression.ZipFile]::CreateFromDirectory($payload,$payloadZip)
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$setup = Join-Path $OutDir 'AJAZZ-TTX-Setup.exe'
$source = Join-Path $PSScriptRoot 'Setup.cs'
$references = '/reference:System.Windows.Forms.dll', '/reference:System.IO.Compression.dll', '/reference:Microsoft.CSharp.dll'
& $compiler /nologo /target:winexe /platform:x64 /codepage:65001 /optimize+ $references "/resource:$payloadZip,payload.zip" "/out:$setup" $source
if ($LASTEXITCODE -ne 0) { throw "Failed to compile setup ($LASTEXITCODE)." }
Copy-Item -LiteralPath $pluginZip -Destination (Join-Path $OutDir $pluginName) -Force
$setup
(Join-Path $OutDir $pluginName)
