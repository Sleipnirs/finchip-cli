import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function readWindowsAcl(path) {
  const script = [
    `$acl = Get-Acl -LiteralPath ${powershellLiteral(path)}`,
    '$entries = @($acl.Access | ForEach-Object {',
    '  [pscustomobject]@{',
    '    sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value',
    '    inherited = $_.IsInherited',
    '    rights = [string]$_.FileSystemRights',
    '  }',
    '})',
    '$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '[pscustomobject]@{ protected = $acl.AreAccessRulesProtected; currentSid = $currentSid; entries = $entries }'
      + ' | ConvertTo-Json -Depth 4 -Compress',
  ].join('\n');
  const result = spawnSync(
    'pwsh',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '', result.stderr);
  return JSON.parse(result.stdout);
}

export function assertOwnerOnlyPermissions(path, mode) {
  if (process.platform !== 'win32') {
    assert.equal(statSync(path).mode & 0o777, mode);
    return;
  }

  const acl = readWindowsAcl(path);
  assert.equal(
    acl.protected,
    true,
    `Windows ACL inheritance must be disabled: ${JSON.stringify(acl)}`,
  );
  const entries = Array.isArray(acl.entries) ? acl.entries : [acl.entries];
  assert.ok(entries.length >= 1, 'Windows ACL must contain an owner entry.');
  assert.ok(entries.some(entry => entry.sid === acl.currentSid), 'Current user must retain access.');
  assert.ok(entries.every(entry => entry.inherited === false), 'No inherited ACL entries are allowed.');
  assert.ok(
    entries.every(entry => [acl.currentSid, 'S-1-5-18'].includes(entry.sid)),
    `Unexpected Windows ACL principal: ${JSON.stringify(entries)}`,
  );
}
