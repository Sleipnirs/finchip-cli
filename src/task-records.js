import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writePrivateTextFile } from './private-files.js';

const TASK_DIR = join(homedir(), '.finchip', 'tasks');
const UUID_RE = /^[0-9a-f-]{36}$/i;

export function taskRecordPath(id, directory = TASK_DIR) {
  if (!UUID_RE.test(String(id))) throw new Error('Invalid Task ID.');
  return join(directory, `${String(id).toLowerCase()}.json`);
}

export function saveTaskRecord(record, options = {}) {
  const safe = {
    version: 2,
    taskId: record.taskId,
    kind: record.kind,
    origin: record.origin,
    walletAddr: record.walletAddr,
    status: record.status,
    planHash: record.planHash ?? null,
    plan: record.plan ?? null,
    broadcastAttemptId: record.broadcastAttemptId ?? null,
    broadcastAttempted: Boolean(record.broadcastAttempted),
    txHash: record.txHash ?? null,
    updatedAt: new Date(options.now ?? Date.now()).toISOString(),
  };
  const serialized = JSON.stringify(safe);
  if (/claimSecret|cookie|signature|privateKey|calldata|rawTransaction/i.test(serialized)) throw new Error('Task execution record contains forbidden material.');
  writePrivateTextFile(taskRecordPath(record.taskId, options.directory), `${JSON.stringify(safe, null, 2)}\n`);
  return safe;
}

export function loadTaskRecord(id, options = {}) {
  const path = taskRecordPath(id, options.directory);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function listTaskRecords(options = {}) {
  const directory = options.directory || TASK_DIR;
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => name.endsWith('.json')).map(name => {
    try { return JSON.parse(readFileSync(join(directory, name), 'utf8')); } catch { return null; }
  }).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
