$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$privateRoot = Join-Path $taskRoot '.secrets'
New-Item -ItemType Directory -Force -Path $privateRoot | Out-Null
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner((New-Object System.Security.Principal.NTAccount($owner)))
foreach ($principal in @($owner, 'NT AUTHORITY\SYSTEM')) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $privateRoot -AclObject $acl
Write-Output 'Private credential directory restricted to this Windows user and SYSTEM.'
