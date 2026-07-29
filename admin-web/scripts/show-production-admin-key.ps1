$ErrorActionPreference = "Stop"
$credentialPath = Join-Path (Split-Path $PSScriptRoot -Parent) ".production-credentials.dpapi"
if (-not (Test-Path -LiteralPath $credentialPath)) {
    throw "Production credentials have not been provisioned on this Windows account."
}

Add-Type -AssemblyName System.Security
$protected = [System.IO.File]::ReadAllBytes($credentialPath)
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $protected,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
$credentials = [System.Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json
Write-Output $credentials.admin_key
