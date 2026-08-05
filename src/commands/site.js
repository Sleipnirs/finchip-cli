import { loadConfig, resolveWalletPrivateKey } from '../config.js';
import { privateKeyToAccount } from 'viem/accounts';
import { FinchipAuthClient, FinchipAuthError } from '../auth-client.js';
import { runLocalConfirmation } from '../localhost-confirmation.js';
import { assertSameFinchipOrigin } from '../site-origin.js';
import { emitFailure, emitResult, ok } from '../utils.js';

export async function openCreatorView(options = {}, dependencies = {}) {
  const config = loadConfig();
  const walletAddr = privateKeyToAccount(resolveWalletPrivateKey(config)).address.toLowerCase();
  const auth = dependencies.authClient || new FinchipAuthClient(dependencies);
  if (!auth.hasPersistedCredentials()) throw new FinchipAuthError('SESSION_REAUTH_REQUIRED', 'Run `finchip login` before opening a wallet-bound Site view.', 2);
  const session = await auth.getSession();
  if (!session.authenticated
    || session.authMode !== 'agent_cli'
    || session.account?.clientKind !== 'cli'
    || session.account?.authMode !== 'agent_cli'
    || session.wallet?.clientKind !== 'cli'
    || session.wallet?.authMode !== 'agent_cli'
    || session.wallet.walletAddr?.toLowerCase() !== walletAddr) {
    throw new FinchipAuthError('SESSION_REAUTH_REQUIRED', 'The saved CLI session is expired, revoked, or belongs to another wallet. Run `finchip login`.', 2);
  }
  const returnTo = options.skill ? `/skills/${encodeURIComponent(options.skill)}/manage` : '/dashboard';
  return runLocalConfirmation({
    origin: auth.origin, walletAddr, purpose: `Open the Creator view at ${returnTo}`,
    openBrowser: dependencies.openBrowser,
    onConfirm: async () => {
      const { response, payload } = await auth.json('/api/auth/cli-browser-handoffs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnTo }),
      });
      if (!response.ok) throw new FinchipAuthError(payload?.code || 'BROWSER_HANDOFF_FAILED', payload?.error || 'Unable to open the Creator view.', response.status >= 500 ? 5 : 3);
      return { ...payload, redirectUrl: assertSameFinchipOrigin(payload.handoffUrl).toString() };
    },
  });
}

export async function cmdSiteOpen(options = {}) {
  try {
    if (options.view !== 'creator') throw new FinchipAuthError('SITE_VIEW_UNSUPPORTED', 'Only --view creator is supported.', 3);
    const result = await openCreatorView(options);
    emitResult(options, { ok: true, code: 'BROWSER_HANDOFF_OPENED', handoffId: result.handoffId, view: options.view, skill: options.skill || null }, () => ok('Opened the wallet-bound FinChip Creator view in your browser.'));
  } catch (error) { emitFailure(options, error); }
}
