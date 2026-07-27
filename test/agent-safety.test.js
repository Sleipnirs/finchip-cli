import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

const ADDR = '0x1111111111111111111111111111111111111111';

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/finchip.js', ...args], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        FINCHIP_API_URL: 'http://127.0.0.1:1',
        FINCHIP_PRIVATE_KEY: '',
      },
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

test('transaction and payment commands require explicit confirmation before external work', async () => {
  const cases = [
    { args: ['register'], code: 'REGISTER_CONFIRM_REQUIRED' },
    { args: ['trade', 'buy', '--id', '1'], code: 'TRADE_CONFIRM_REQUIRED' },
    { args: ['trade', 'sell', '--slug', 'demo', '--price', '0.01'], code: 'TRADE_CONFIRM_REQUIRED' },
    { args: ['trade', 'cancel', '--id', '1'], code: 'TRADE_CONFIRM_REQUIRED' },
    { args: ['pay', 'https://example.com'], code: 'PAYMENT_CONFIRM_REQUIRED' },
  ];

  for (const item of cases) {
    const result = await runCli(item.args);
    assert.equal(result.code, 3, `${item.args.join(' ')}\n${result.stderr}\n${result.stdout}`);
    assert.match(result.stderr, new RegExp(item.code));
    assert.match(result.stderr, /--yes/);
  }
});

test('publish resume and price set expose stable confirmation errors before credentials or RPC', async () => {
  const publish = await runCli(['skill', 'publish', '--resume', 'demo', '--json']);
  assert.equal(publish.code, 3, `${publish.stderr}\n${publish.stdout}`);
  assert.equal(JSON.parse(publish.stdout).code, 'PUBLISH_CONFIRM_REQUIRED');

  const price = await runCli([
    'skill', 'price', 'set', 'demo', '--chain', 'base', '--addr', ADDR, '--price', '0.01', '--json',
  ]);
  assert.equal(price.code, 3, `${price.stderr}\n${price.stdout}`);
  const payload = JSON.parse(price.stdout);
  assert.equal(payload.code, 'PRICE_CONFIRM_REQUIRED');
  assert.equal(payload.chainId, 8453);
  assert.equal(payload.contractAddr, ADDR);
});
