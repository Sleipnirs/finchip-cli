import { loadConfig, resolveWalletPrivateKey, WalletKeyError } from '../config.js';
import { FinchipAuthClient, FinchipAuthError } from '../auth-client.js';
import { loginTask } from './task.js';
import { parseFinchipTaskUrl } from '../site-origin.js';
import { emitFailure, emitResult, fmtAddr, hd, inf, ok, sep, wrn } from '../utils.js';

function accountSummary(session) {
  return {
    userId: session.identity?.userId ?? session.account?.userId ?? null,
    username: session.identity?.username ?? null,
    walletAddr: session.wallet?.walletAddr ?? session.identity?.walletAddr ?? null,
    connections: {
      wallet: Boolean(session.connections?.wallet),
      github: Boolean(session.connections?.github),
    },
  };
}

function outputFailure(options, error) {
  const normalized = error instanceof FinchipAuthError || error instanceof WalletKeyError
    ? error
    : new FinchipAuthError('AUTH_NETWORK_ERROR', error instanceof Error ? error.message : 'Authentication failed.');
  emitFailure(options, normalized, { fields: { authenticated: false } });
}

export async function cmdLogin(options = {}) {
  try {
    const client = new FinchipAuthClient();
    if (client.hasPersistedCredentials()) {
      const current = await client.getSession();
      if (current.authenticated && current.account?.clientKind === 'cli' && current.wallet?.clientKind === 'cli') {
        throw new FinchipAuthError('AUTH_ALREADY_ACTIVE', 'A FinChip session is already active. Run `finchip logout` first.', 3);
      }
      client.clearCredentials();
    }

    // Fail on a missing or disabled wallet before creating remote login state.
    resolveWalletPrivateKey(loadConfig());

    const created = await client.json('/api/auth/cli-login/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnTo: '/dashboard' }),
    });
    if (!created.response.ok || typeof created.payload?.taskUrl !== 'string') {
      throw new FinchipAuthError(created.payload?.code || 'AUTH_CHALLENGE_FAILED', created.payload?.error || 'Failed to create CLI login request.', created.response.status >= 500 ? 5 : 3);
    }
    await loginTask(parseFinchipTaskUrl(created.payload.taskUrl), { authClient: client });
    const session = await client.getSession();
    const sessionWallet = session.wallet?.walletAddr?.toLowerCase();
    if (!session.authenticated || session.account?.clientKind !== 'cli' || session.wallet?.clientKind !== 'cli') {
      client.clearCredentials();
      throw new FinchipAuthError('AUTH_SESSION_INVALID', 'FinChip did not create an authenticated CLI session.', 3);
    }
    client.persistCredentials();

    const result = { ok: true, code: 'AUTHENTICATED', authenticated: true, origin: client.origin, account: accountSummary(session) };
    emitResult(options, result, () => {
      hd('FinChip CLI — login');
      sep();
      ok('Authenticated with FinChip');
      inf(`origin:   ${client.origin}`);
      inf(`username: ${result.account.username || '(not set)'}`);
      inf(`userId:   ${result.account.userId}`);
      inf(`wallet:   ${fmtAddr(sessionWallet)}`);
    });
  } catch (error) {
    outputFailure(options, error);
  }
}

export async function cmdStatus(options = {}) {
  try {
    const client = new FinchipAuthClient();
    if (!client.hasPersistedCredentials()) {
      const result = { ok: false, code: 'SESSION_REAUTH_REQUIRED', authenticated: false, origin: client.origin, account: null };
      emitResult(options, result, () => inf(`Not authenticated with ${client.origin}. Run \`finchip login\`.`));
      process.exitCode = 2;
      return;
    }
    const session = await client.getSession();
    if (!session.authenticated || session.account?.clientKind !== 'cli' || session.wallet?.clientKind !== 'cli') {
      client.clearCredentials();
      const result = { ok: false, code: 'SESSION_REAUTH_REQUIRED', authenticated: false, origin: client.origin, account: null };
      emitResult(options, result, () => inf('FinChip CLI session is expired, revoked, or invalid. Run `finchip login`.'));
      process.exitCode = 2;
      return;
    }
    const result = { ok: true, code: 'AUTHENTICATED', authenticated: true, origin: client.origin, account: accountSummary(session) };
    emitResult(options, result, () => {
      hd('FinChip CLI — status');
      sep();
      ok('Authenticated');
      inf(`origin:   ${client.origin}`);
      inf(`username: ${result.account.username || '(not set)'}`);
      inf(`userId:   ${result.account.userId}`);
      inf(`wallet:   ${fmtAddr(result.account.walletAddr)}`);
      inf(`connections: wallet=${result.account.connections.wallet ? 'yes' : 'no'}, github=${result.account.connections.github ? 'yes' : 'no'}`);
    });
  } catch (error) {
    outputFailure(options, error);
  }
}

export async function cmdLogout(options = {}) {
  try {
    const client = new FinchipAuthClient();
    if (!client.hasPersistedCredentials()) {
      const result = { ok: true, code: 'LOGGED_OUT', authenticated: false, origin: client.origin };
      emitResult(options, result, () => ok('No active FinChip session.'));
      return;
    }
    // Best-effort remote revocation; local credentials are always cleared.
    let remoteRevoked = true;
    let remoteError = null;
    try {
      const { response, payload } = await client.json('/api/auth/logout', {
        method: 'POST',
        persistCookies: false,
      });
      if (!response.ok) {
        remoteRevoked = false;
        remoteError = payload?.error || `Logout failed with status ${response.status}.`;
      }
    } catch (error) {
      remoteRevoked = false;
      remoteError = error instanceof Error ? error.message : 'Unable to reach the FinChip API.';
    }
    client.clearCredentials();
    const result = { ok: true, code: 'LOGGED_OUT', authenticated: false, origin: client.origin, remoteRevoked };
    emitResult(options, result, () => {
      ok(`Logged out from ${client.origin}.`);
      if (!remoteRevoked) {
        wrn(`Remote session revocation failed (${remoteError}). Local credentials were cleared; the server-side session may still be valid until it expires.`);
      }
    });
  } catch (error) {
    outputFailure(options, error);
  }
}
