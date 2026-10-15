[CmdletBinding()]
param([Parameter(Mandatory)][string]$ExpectedHostname)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if(-not $env:COMPUTERNAME.Equals($ExpectedHostname,[StringComparison]::OrdinalIgnoreCase)){throw 'Exact D0 mismatch'}
$common=[Environment]::GetFolderPath('CommonApplicationData')
$network=Join-Path $common 'NetworkFleet';$shared=Join-Path $common 'LocalControlMCP'
$user=[string](Get-CimInstance Win32_ComputerSystem).UserName
if(-not $user){throw 'Logged-in user required'}
$sid=([Security.Principal.NTAccount]::new($user)).Translate([Security.Principal.SecurityIdentifier])
$backup=Join-Path $network ('backups\acl-'+(Get-Date -Format 'yyyyMMddHHmmss'))
New-Item -ItemType Directory -Path $backup -Force|Out-Null
function Set-LcmAcl([string]$Target,[bool]$PublicRead,[bool]$OwnerRead){
 if(-not(Test-Path -LiteralPath $Target)){return}
 $item=Get-Item -LiteralPath $Target
 if($item.LinkType){throw 'Refusing ACL mutation through a reparse point'}
 $old=Get-Acl -LiteralPath $Target
 $name=([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Target))))+'.sddl'
 [IO.File]::WriteAllText((Join-Path $backup $name),$Target+"`n"+$old.Sddl,[Text.UTF8Encoding]::new($false))
 $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false)
 foreach($id in @('S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($id),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
 if($PublicRead){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))}
 if($OwnerRead){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))}
 Set-Acl -LiteralPath $Target -AclObject $acl
}
Set-LcmAcl $network $false $true
Set-LcmAcl (Join-Path $network 'agent') $false $false
Set-LcmAcl $shared $true $false
Set-LcmAcl (Join-Path $shared 'DesktopCommanderMCP') $true $false
$identity=Join-Path $network 'agent\device-identity.json'
if((Get-Acl -LiteralPath $identity).Access|Where-Object{$_.IdentityReference.Value -match 'Users|Everyone|Authenticated Users'}){throw 'Identity file retained a broad ACL'}
[ordered]@{status='PASS';hostname=$ExpectedHostname;identity_acl='SYSTEM/Administrators';runtime_acl='Users read/execute';rollback=$backup}|ConvertTo-Json -Compress
