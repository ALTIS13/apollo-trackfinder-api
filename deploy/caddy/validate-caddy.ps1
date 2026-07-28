[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$CaddyImage = "docker.io/library/caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d"
$RunId = [Guid]::NewGuid().ToString("N")
$HashContainer = "apollo-caddy-hash-$RunId"
$ValidationContainer = "apollo-caddy-validate-$RunId"
$TemporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) "apollo-caddy-validate-$RunId"
$ImageWasPresent = $false

function Invoke-Docker {
    param(
        [Parameter(Mandatory = $true)]
        [string[]] $Arguments,
        [string] $StandardInput
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = "docker"
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    if ($null -ne $StandardInput) {
        $startInfo.RedirectStandardInput = $true
    }
    foreach ($argument in $Arguments) {
        [void] $startInfo.ArgumentList.Add($argument)
    }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    [void] $process.Start()
    if ($null -ne $StandardInput) {
        $process.StandardInput.WriteLine($StandardInput)
        $process.StandardInput.Close()
    }
    $stdout = $process.StandardOutput.ReadToEnd()
    [void] $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        throw "Local Docker command failed with exit code $($process.ExitCode)"
    }
    return $stdout
}

function Test-ImagePresent {
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = "docker"
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    [void] $startInfo.ArgumentList.Add("image")
    [void] $startInfo.ArgumentList.Add("inspect")
    [void] $startInfo.ArgumentList.Add($CaddyImage)

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    [void] $process.Start()
    [void] $process.StandardOutput.ReadToEnd()
    [void] $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    return $process.ExitCode -eq 0
}

function Assert-LocalDocker {
    $dockerHost = [Environment]::GetEnvironmentVariable("DOCKER_HOST")
    if (
        -not [string]::IsNullOrWhiteSpace($dockerHost) -and
        -not (
            $dockerHost.StartsWith("npipe://", [StringComparison]::OrdinalIgnoreCase) -or
            $dockerHost.StartsWith("unix://", [StringComparison]::OrdinalIgnoreCase)
        )
    ) {
        throw "Caddy validation requires a local Docker endpoint"
    }

    $context = (Invoke-Docker -Arguments @("context", "show")).Trim()
    if ([string]::IsNullOrWhiteSpace($context)) {
        throw "Caddy validation requires a local Docker context"
    }
    $endpointJson = (
        Invoke-Docker -Arguments @(
            "context",
            "inspect",
            $context,
            "--format",
            "{{json .Endpoints.docker.Host}}"
        )
    ).Trim()
    $endpoint = $endpointJson | ConvertFrom-Json
    if (
        -not (
            $endpoint.StartsWith("npipe://", [StringComparison]::OrdinalIgnoreCase) -or
            $endpoint.StartsWith("unix://", [StringComparison]::OrdinalIgnoreCase)
        )
    ) {
        throw "Caddy validation requires a local Docker endpoint"
    }
}

try {
    Assert-LocalDocker
    $ImageWasPresent = Test-ImagePresent
    [void] (New-Item -ItemType Directory -Path $TemporaryDirectory)

    $passwordBytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(48)
    $disposablePassword = [Convert]::ToBase64String($passwordBytes)
    $hashOutput = Invoke-Docker -Arguments @(
        "run",
        "--rm",
        "--name",
        $HashContainer,
        "--network",
        "none",
        "--read-only",
        "-i",
        $CaddyImage,
        "caddy",
        "hash-password"
    ) -StandardInput $disposablePassword
    $disposablePassword = $null
    [Array]::Clear($passwordBytes, 0, $passwordBytes.Length)

    $passwordHash = $hashOutput.Trim()
    if ($passwordHash -notmatch '^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$') {
        throw "Caddy did not produce a valid disposable bcrypt hash"
    }

    $wrapperPath = Join-Path $TemporaryDirectory "Caddyfile"
    $environmentPath = Join-Path $TemporaryDirectory "validation.env"
    [IO.File]::WriteAllText(
        $wrapperPath,
        "{`n`tadmin off`n`tauto_https off`n}`n`nimport /etc/caddy/apollo.caddyfile`n",
        [Text.UTF8Encoding]::new($false)
    )
    [IO.File]::WriteAllText(
        $environmentPath,
        "APOLLO_ADMIN_CADDY_USER=release-validator`nAPOLLO_ADMIN_CADDY_PASSWORD_HASH=$passwordHash`n",
        [Text.UTF8Encoding]::new($false)
    )
    $passwordHash = $null
    $hashOutput = $null

    $includePath = Join-Path $PSScriptRoot "apollo.caddyfile"
    [void] (Invoke-Docker -Arguments @(
        "run",
        "--rm",
        "--name",
        $ValidationContainer,
        "--network",
        "none",
        "--read-only",
        "--env-file",
        $environmentPath,
        "--mount",
        "type=bind,source=$wrapperPath,target=/etc/caddy/Caddyfile,readonly",
        "--mount",
        "type=bind,source=$includePath,target=/etc/caddy/apollo.caddyfile,readonly",
        "--tmpfs",
        "/config:rw,noexec,nosuid,size=16m",
        "--tmpfs",
        "/data:rw,noexec,nosuid,size=16m",
        $CaddyImage,
        "caddy",
        "validate",
        "--config",
        "/etc/caddy/Caddyfile",
        "--adapter",
        "caddyfile"
    ))

    Write-Output "Caddy include validation passed with $CaddyImage"
}
finally {
    $disposablePassword = $null
    $passwordHash = $null
    $hashOutput = $null
    foreach ($container in @($HashContainer, $ValidationContainer)) {
        try {
            [void] (Invoke-Docker -Arguments @("rm", "-f", $container))
        }
        catch {
            # --rm normally removes these exact containers before this fallback.
        }
    }
    if (Test-Path -LiteralPath $TemporaryDirectory) {
        $resolvedTemporaryDirectory = [IO.Path]::GetFullPath($TemporaryDirectory)
        $resolvedTemporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
        if (-not $resolvedTemporaryDirectory.StartsWith(
            $resolvedTemporaryRoot,
            [StringComparison]::OrdinalIgnoreCase
        )) {
            throw "Refusing to remove a temporary directory outside the system temp root"
        }
        Remove-Item -LiteralPath $TemporaryDirectory -Recurse -Force
    }
    if (-not $ImageWasPresent) {
        try {
            [void] (Invoke-Docker -Arguments @("image", "rm", $CaddyImage))
        }
        catch {
            # A concurrent exact-digest user owns the remaining reference.
        }
    }
}
