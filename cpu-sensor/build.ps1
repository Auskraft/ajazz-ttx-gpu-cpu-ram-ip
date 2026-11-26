param([string]$Destination = (Join-Path $PSScriptRoot 'dist'))

$ErrorActionPreference = 'Stop'
$version = '0.9.6'
$archiveHash = '086D9F1B5A99E643EDC2CFAAAC16051685B551E4C5AC0B32A57C58C0E529C001'
$releaseUri = "https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/download/v$version/LibreHardwareMonitor.zip"
$rawSource = "https://raw.githubusercontent.com/LibreHardwareMonitor/LibreHardwareMonitor/v$version"
$archivePath = Join-Path $PSScriptRoot 'upstream.zip'
if (!(Test-Path -LiteralPath $archivePath)) {
    Invoke-WebRequest -UseBasicParsing -Uri $releaseUri -OutFile $archivePath
}
if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $archiveHash) {
    throw 'The LibreHardwareMonitor release archive has an unexpected SHA-256 checksum.'
}

New-Item -ItemType Directory -Path $Destination -Force | Out-Null
$noticesDir = Join-Path $Destination 'licenses'
New-Item -ItemType Directory -Path $noticesDir -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    foreach ($file in 'LibreHardwareMonitorLib.dll', 'HidSharp.dll', 'System.Memory.dll', 'System.Runtime.CompilerServices.Unsafe.dll', 'System.Buffers.dll', 'System.Numerics.Vectors.dll') {
        $entry = $zip.GetEntry($file)
        if ($null -eq $entry) { throw "Missing CPU sensor dependency: $file" }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $Destination $file), $true)
    }
}
finally {
    $zip.Dispose()
}

Invoke-WebRequest -UseBasicParsing -Uri "$rawSource/LICENSE" -OutFile (Join-Path $noticesDir 'LibreHardwareMonitor-MPL-2.0.txt')
Invoke-WebRequest -UseBasicParsing -Uri "$rawSource/THIRD-PARTY-NOTICES.txt" -OutFile (Join-Path $noticesDir 'LibreHardwareMonitor-Third-Party-Notices.txt')
Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/IntergatedCircuits/HidSharp/main-2.6/LICENSE.txt' -OutFile (Join-Path $noticesDir 'HidSharp-License.txt')
Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/IntergatedCircuits/HidSharp/main-2.6/NOTICE.txt' -OutFile (Join-Path $noticesDir 'HidSharp-Notice.txt')
Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/dotnet/runtime/v10.0.3/LICENSE.TXT' -OutFile (Join-Path $noticesDir 'Dotnet-Runtime-MIT.txt')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'NOTICE.md') -Destination $noticesDir -Force

$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$lhmAssembly = Join-Path $Destination 'LibreHardwareMonitorLib.dll'
$output = Join-Path $Destination 'CpuSensor.exe'
$source = Join-Path $PSScriptRoot 'CpuSensor.cs'
& $compiler /nologo /target:exe /platform:x64 /optimize+ /reference:System.Web.Extensions.dll "/out:$output" "/reference:$lhmAssembly" $source
if ($LASTEXITCODE -ne 0) { throw "Failed to compile CPU sensor ($LASTEXITCODE)." }
