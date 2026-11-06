param([Parameter(Mandatory=$true)][string]$Stage)
$ErrorActionPreference='Stop'
$item=Get-Item -LiteralPath $Stage -Force
if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or @(Get-ChildItem -LiteralPath $Stage -Force).Count -ne 0){throw 'LEGACY_STAGE_NOT_EMPTY_DIRECTORY'}
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User
$sids=@($owner,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($owner);$acl.SetAccessRuleProtection($true,$false)
foreach($sid in $sids){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
Set-Acl -LiteralPath $Stage -AclObject $acl
$actual=Get-Acl -LiteralPath $Stage
if(-not $actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $owner.Value){throw 'LEGACY_STAGE_ACL'}
$rules=@($actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
if($rules.Count -ne 3){throw 'LEGACY_STAGE_ACL'}
foreach($rule in $rules){
 if($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -notin $sids.Value -or $rule.FileSystemRights -ne 'FullControl' -or $rule.InheritanceFlags -ne 'ContainerInherit, ObjectInherit'){throw 'LEGACY_STAGE_ACL'}
}
'{"status":"PROTECTED_EMPTY_STAGE","principals":3}'
