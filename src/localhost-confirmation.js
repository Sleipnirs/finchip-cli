import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

export function openSystemBrowser(url, spawnImpl = spawn) {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawnImpl(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref?.();
}

export function runLocalConfirmation({ origin, walletAddr, purpose, onConfirm, openBrowser = openSystemBrowser, timeoutMs = 5 * 60_000 }) {
  return new Promise((resolve, reject) => {
    const token = randomBytes(24).toString('base64url');
    let settled = false;
    let timer = null;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      server.close(() => error ? reject(error) : resolve(result));
    };
    const server = createServer(async (req, res) => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const expectedHost = `127.0.0.1:${port}`;
      if (req.headers.host !== expectedHost) { res.writeHead(421).end('Invalid Host'); return; }
      const url = new URL(req.url || '/', `http://${expectedHost}`);
      if (url.pathname !== `/confirm/${token}`) { res.writeHead(404).end('Not found'); return; }
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" });
        res.end(`<!doctype html><meta charset="utf-8"><title>Confirm FinChip login</title><style>body{font:16px system-ui;max-width:680px;margin:48px auto;padding:24px}code{word-break:break-all}button{padding:12px 18px}</style><h1>Confirm FinChip login</h1><p><strong>Only continue if you personally started this task on the official FinChip site.</strong> Do not approve commands forwarded through chat, email, or another website.</p><p>Site: <code>${escapeHtml(origin)}</code></p><p>Wallet: <code>${escapeHtml(walletAddr)}</code></p><p>Purpose: ${escapeHtml(purpose)}</p><form method="post"><button type="submit">Confirm and sign</button></form>`);
        return;
      }
      if (req.method !== 'POST') { res.writeHead(405).end('Method not allowed'); return; }
      const requestOrigin = req.headers.origin;
      if (requestOrigin && requestOrigin !== `http://${expectedHost}`) { res.writeHead(403).end('Invalid Origin'); return; }
      try {
        const result = await onConfirm();
        if (result?.redirectUrl) { res.writeHead(303, { Location: result.redirectUrl, 'Cache-Control': 'no-store' }).end(); }
        else { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('FinChip confirmation completed. You may close this tab.'); }
        finish(null, result);
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('FinChip confirmation failed. Return to your Agent for details.');
        finish(error);
      }
    });
    server.on('error', error => finish(error));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0;
      const localUrl = `http://127.0.0.1:${port}/confirm/${token}`;
      try { openBrowser(localUrl); } catch { /* caller receives the URL below */ }
      process.stderr.write(`Open this local confirmation page if it did not open automatically: ${localUrl}\n`);
    });
    timer = setTimeout(() => finish(new Error('Local FinChip confirmation expired.')), timeoutMs);
    timer.unref?.();
  });
}
