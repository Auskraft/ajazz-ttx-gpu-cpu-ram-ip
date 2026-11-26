param([Parameter(Mandatory)][string]$Destination)

$ErrorActionPreference = 'Stop'
$version = '2.5.1'
$name = "PresentMon-$version-x64.exe"
$repository = 'https://github.com/GameTechDev/PresentMon'
$binaryUrl = "$repository/releases/download/v$version/$name"
$licenseUrl = "https://raw.githubusercontent.com/GameTechDev/PresentMon/v$version/LICENSE.txt"
$binaryHash = '9BEC3083069F58F911E6A512F4806DB51A27BD096103087BC1D05EF54C80A191'
$cache = Join-Path $PSScriptRoot 'dist'

New-Item -Path $cache,$Destination -ItemType Directory -Force | Out-Null
$binary = Join-Path $cache $name
if (!(Test-Path -LiteralPath $binary)) {
    $download = "$binary.download"
    Invoke-WebRequest -UseBasicParsing -Uri $binaryUrl -OutFile $download
    if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $binaryHash) {
        throw "PresentMon $version download did not match the pinned SHA-256."
    }
    Move-Item -LiteralPath $download -Destination $binary
}
if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash -ne $binaryHash) {
    throw "Cached PresentMon $version did not match the pinned SHA-256."
}
if ((Get-AuthenticodeSignature -LiteralPath $binary).Status -ne 'Valid') {
    throw "PresentMon $version Authenticode signature could not be validated."
}

$license = Join-Path $PSScriptRoot 'LICENSE-PresentMon.txt'
if (!(Test-Path -LiteralPath $license)) {
    throw "Missing the upstream PresentMon license from $licenseUrl."
}
Copy-Item -LiteralPath $binary -Destination (Join-Path $Destination 'PresentMon.exe')
Copy-Item -LiteralPath $license -Destination $Destination
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'NOTICE.md') -Destination $Destination

$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$foregroundSource = Join-Path $PSScriptRoot 'ForegroundProcess.cs'
$foregroundBinary = Join-Path $Destination 'ForegroundProcess.exe'
& $compiler /nologo /target:exe /platform:x64 /optimize+ "/out:$foregroundBinary" $foregroundSource
if ($LASTEXITCODE -ne 0) { throw "Foreground process helper compilation failed ($LASTEXITCODE)." }
