import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { hashTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  buildCreatorAttestation,
  executeCreatorAttestation,
} from '../src/creator-attestation.js';
import { CHIP_ABI, CHIP_721_ABI } from '../src/protocol.js';

const PRIVATE_KEY = `0x${'11'.repeat(32)}`;
const ACCOUNT = privateKeyToAccount(PRIVATE_KEY);
const CHIP = '0x1111111111111111111111111111111111111111';
const HASH = `0x${'ab'.repeat(32)}`;
const TX_HASH = `0x${'cd'.repeat(32)}`;

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/finchip.js', ...args], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function makeClients(overrides = {}) {
  let verified = false;
  const calls = [];
  const values = {
    genesisCreator: ACCOUNT.address,
    creatorSignatureSet: false,
    isCreatorVerified: () => verified,
    slug: 'demo_finchip',
    contentHash: HASH,
    ...overrides.reads,
  };
  const publicClient = {
    async readContract(args) {
      calls.push({ type: 'read', ...args });
      const value = values[args.functionName];
      if (value instanceof Error) throw value;
      return typeof value === 'function' ? value() : value;
    },
    async waitForTransactionReceipt(args) {
      calls.push({ type: 'receipt', ...args });
      if (overrides.receiptError) throw overrides.receiptError;
      verified = overrides.verifiedAfter === false ? false : true;
      return { status: overrides.receiptStatus || 'success' };
    },
  };
  const walletClient = {
    async signTypedData(args) {
      calls.push({ type: 'sign', ...args });
      return `0x${'ef'.repeat(65)}`;
    },
    async writeContract(args) {
      calls.push({ type: 'write', ...args });
      if (overrides.writeError) throw overrides.writeError;
      return TX_HASH;
    },
  };
  return { publicClient, walletClient, calls };
}

test('attestation ABI is present on both ERC-1155 and ERC-721 contracts', () => {
  for (const abi of [CHIP_ABI, CHIP_721_ABI]) {
    for (const name of [
      'genesisCreator',
      'creatorAttestationDigest',
      'creatorSignatureSet',
      'isCreatorVerified',
      'setCreatorSignature',
    ]) {
      assert.ok(abi.some(item => item.type === 'function' && item.name === name), `${name} missing`);
    }
    assert.ok(abi.some(item => item.type === 'event' && item.name === 'CreatorSignatureSet'));
  }
});

test('EIP-712 payload exactly binds chain, chip, slug, and content hash', () => {
  const payload = buildCreatorAttestation(56, CHIP, 'demo_finchip', HASH);
  assert.deepEqual(payload.domain, {
    name: 'FinChipCreatorAttestation',
    version: '1',
    chainId: 56,
    verifyingContract: CHIP,
  });
  assert.equal(payload.primaryType, 'CreatorAttestation');
  assert.deepEqual(payload.message, { chip: CHIP, slug: 'demo_finchip', contentHash: HASH });
  assert.match(hashTypedData(payload), /^0x[0-9a-f]{64}$/);
});

test('dry-run compares the local and on-chain digest without signing or broadcasting', async () => {
  const payload = buildCreatorAttestation(56, CHIP, 'demo_finchip', HASH);
  const clients = makeClients({ reads: { creatorAttestationDigest: hashTypedData(payload) } });
  const result = await executeCreatorAttestation({
    chainId: 56,
    contractAddr: CHIP,
    tokenType: 'erc1155',
    sessionWallet: ACCOUNT.address,
    account: ACCOUNT,
    dryRun: true,
    yes: false,
    ...clients,
  });
  assert.equal(result.code, 'ATTESTATION_DRY_RUN');
  assert.equal(result.slug, 'demo_finchip');
  assert.equal(clients.calls.some(call => call.type === 'sign' || call.type === 'write'), false);
});

test('actual attestation signs once, writes once, waits, and verifies on-chain', async () => {
  const payload = buildCreatorAttestation(56, CHIP, 'demo_finchip', HASH);
  const clients = makeClients({ reads: { creatorAttestationDigest: hashTypedData(payload) } });
  const result = await executeCreatorAttestation({
    chainId: 56,
    contractAddr: CHIP,
    tokenType: 'erc721',
    sessionWallet: ACCOUNT.address,
    account: ACCOUNT,
    dryRun: false,
    yes: true,
    ...clients,
  });
  assert.equal(result.code, 'CREATOR_ATTESTATION_COMPLETE');
  assert.equal(result.txHash, TX_HASH);
  assert.equal(clients.calls.filter(call => call.type === 'sign').length, 1);
  assert.equal(clients.calls.filter(call => call.type === 'write').length, 1);
  assert.equal(clients.calls.filter(call => call.type === 'receipt').length, 1);
  assert.equal(Object.hasOwn(result, 'signature'), false);
});

test('verified, legacy, digest mismatch, and wallet mismatch stop before signing', async () => {
  const verified = makeClients({ reads: { creatorSignatureSet: true, isCreatorVerified: true } });
  const already = await executeCreatorAttestation({
    chainId: 56,
    contractAddr: CHIP,
    tokenType: 'erc1155',
    sessionWallet: ACCOUNT.address,
    account: ACCOUNT,
    dryRun: false,
    yes: true,
    ...verified,
  });
  assert.equal(already.code, 'CREATOR_ALREADY_VERIFIED');
  assert.equal(verified.calls.some(call => call.type === 'sign'), false);

  const legacy = makeClients({ reads: { creatorSignatureSet: new Error('function selector') } });
  await assert.rejects(
    () => executeCreatorAttestation({
      chainId: 56, contractAddr: CHIP, tokenType: 'erc1155',
      sessionWallet: ACCOUNT.address, account: ACCOUNT, dryRun: true, yes: false, ...legacy,
    }),
    error => error.code === 'ATTESTATION_UNSUPPORTED',
  );

  const mismatch = makeClients({ reads: { creatorAttestationDigest: HASH } });
  await assert.rejects(
    () => executeCreatorAttestation({
      chainId: 56, contractAddr: CHIP, tokenType: 'erc1155',
      sessionWallet: ACCOUNT.address, account: ACCOUNT, dryRun: true, yes: false, ...mismatch,
    }),
    error => error.code === 'ATTESTATION_DIGEST_MISMATCH',
  );

  const wallet = makeClients();
  await assert.rejects(
    () => executeCreatorAttestation({
      chainId: 56, contractAddr: CHIP, tokenType: 'erc1155',
      sessionWallet: '0x2222222222222222222222222222222222222222',
      account: ACCOUNT, dryRun: true, yes: false, ...wallet,
    }),
    error => error.code === 'WALLET_MISMATCH',
  );
  assert.equal(wallet.calls.length, 0);
});

test('broadcast and post-receipt failures retain the transaction hash', async () => {
  const payload = buildCreatorAttestation(56, CHIP, 'demo_finchip', HASH);
  const receiptFailed = makeClients({
    reads: { creatorAttestationDigest: hashTypedData(payload) },
    receiptError: new Error('timeout'),
  });
  await assert.rejects(
    () => executeCreatorAttestation({
      chainId: 56, contractAddr: CHIP, tokenType: 'erc1155',
      sessionWallet: ACCOUNT.address, account: ACCOUNT, dryRun: false, yes: true, ...receiptFailed,
    }),
    error => error.code === 'ATTESTATION_TX_FAILED' && error.details.txHash === TX_HASH,
  );

  const verifyFailed = makeClients({
    reads: { creatorAttestationDigest: hashTypedData(payload) },
    verifiedAfter: false,
  });
  await assert.rejects(
    () => executeCreatorAttestation({
      chainId: 56, contractAddr: CHIP, tokenType: 'erc1155',
      sessionWallet: ACCOUNT.address, account: ACCOUNT, dryRun: false, yes: true, ...verifyFailed,
    }),
    error => error.code === 'ATTESTATION_VERIFY_FAILED' && error.details.txHash === TX_HASH,
  );
});

test('attest command requires an explicit deployment before login or RPC', async () => {
  const help = await runCli(['skill', 'manage', 'attest', '--help']);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /--chain <chainId>/);
  assert.match(help.stdout, /--addr <contract>/);
  assert.match(help.stdout, /--dry-run/);
  assert.match(help.stdout, /--yes/);

  const invalid = await runCli(['skill', 'manage', 'attest', 'demo_finchip', '--json'], {
    FINCHIP_API_URL: 'http://127.0.0.1:1',
  });
  assert.equal(invalid.code, 3, `${invalid.stderr}\n${invalid.stdout}`);
  assert.equal(JSON.parse(invalid.stdout).code, 'SKILL_DEPLOYMENT_MISMATCH');

  const badChain = await runCli([
    'skill', 'manage', 'attest', 'demo_finchip',
    '--chain', 'not-a-chain', '--addr', CHIP, '--json',
  ], { FINCHIP_API_URL: 'http://127.0.0.1:1' });
  assert.equal(badChain.code, 3, `${badChain.stderr}\n${badChain.stdout}`);
  assert.equal(JSON.parse(badChain.stdout).code, 'SKILL_DEPLOYMENT_MISMATCH');
});
