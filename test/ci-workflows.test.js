import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function repositoryFile(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('test workflow covers supported runtimes, macOS architectures, and Git Bash', async () => {
  const workflow = await repositoryFile('.github/workflows/test.yml');

  for (const expected of [
    'ubuntu-latest',
    'windows-latest',
    'macos-latest',
    'macos-15-intel',
    'node: 22',
    'node: 24',
    'node: 26',
    'shell: bash',
    'command -v whoami',
    'npm ci --ignore-scripts',
    'npm run check:node20-guard',
    'npm run check:package',
    'npm run check:syntax',
    'npm audit --omit=dev --audit-level=high',
  ]) {
    assert.ok(workflow.includes(expected), `workflow must include ${expected}`);
  }
  assert.ok(!workflow.includes('--no-package-lock'));
});

test('required CI aggregator always reports skipped, cancelled, and failed dependencies', async () => {
  const workflow = await repositoryFile('.github/workflows/test.yml');

  assert.match(workflow, /ci-required:\s*\n(?:\s+name:.*\n)?\s+if:\s*(?:\$\{\{\s*)?always\(\)/);
  assert.match(workflow, /needs:\s*\[test, git-bash, node20-guard, gates\]/);
  assert.match(workflow, /contains\(needs\.\*\.result, 'failure'\)/);
  assert.match(workflow, /contains\(needs\.\*\.result, 'cancelled'\)/);
  assert.match(workflow, /contains\(needs\.\*\.result, 'skipped'\)/);
});

test('security workflow runs a daily high-severity production audit', async () => {
  const workflow = await repositoryFile('.github/workflows/security.yml');

  assert.match(workflow, /cron:\s*['"]17 9 \* \* \*['"]/);
  assert.ok(workflow.includes('workflow_dispatch:'));
  assert.ok(workflow.includes('npm ci --ignore-scripts'));
  assert.ok(workflow.includes('npm audit --omit=dev --audit-level=high'));
});

test('Dependabot sends version updates to preview and groups npm minor and patch updates', async () => {
  const config = await repositoryFile('.github/dependabot.yml');

  assert.ok(config.includes('package-ecosystem: "npm"'));
  assert.ok(config.includes('package-ecosystem: "github-actions"'));
  assert.equal(config.match(/target-branch:\s*"preview"/g)?.length, 2);
  assert.match(config, /update-types:\s*\["minor", "patch"\]/);
});
