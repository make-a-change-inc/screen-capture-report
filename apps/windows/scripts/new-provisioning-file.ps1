param(
    [Parameter(Mandatory = $true)][string]$AdminApiUrl,
    [Parameter(Mandatory = $true)][string]$EmployeeId,
    [Parameter(Mandatory = $true)][string]$Department,
    [Parameter(Mandatory = $true)][securestring]$DeviceToken,
    [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = "Stop"
$credential = [pscredential]::new("device", $DeviceToken)
$plainToken = $credential.GetNetworkCredential().Password
try {
    $payload = [ordered]@{
        schema_version = 1
        admin_api_url = $AdminApiUrl.TrimEnd("/")
        employee_id = $EmployeeId
        department = $Department
        device_token = $plainToken
    }
    $payload | ConvertTo-Json | Set-Content -LiteralPath $OutputPath -Encoding UTF8
    Write-Warning "The provisioning file contains a device credential. Delete it after import."
} finally {
    $plainToken = $null
}
