import { FinchipAuthClient, FinchipAuthError } from './auth-client.js';
import { ACTION_INTENT_SCHEMA_HASH, SUPPORTED_ACTION_INTENT_KINDS } from './action-intent-contracts.js';
import { isCliVersionSupported } from './version-policy.js';

function errorFor(response, payload) {
  const code = payload?.code || (response.status === 401 ? 'SESSION_REAUTH_REQUIRED' : 'TASK_REQUEST_FAILED');
  const exitCode = response.status >= 500 ? 5 : response.status === 401 ? 2 : 3;
  return new FinchipAuthError(code, payload?.error || `FinChip Agent Task request failed with status ${response.status}.`, exitCode, {
    retryAfterSeconds: payload?.retryAfterSeconds ?? null,
  });
}

export class ActionIntentClient {
  constructor(options = {}) {
    this.auth = options.authClient || new FinchipAuthClient(options);
    this.cliVersion = options.cliVersion;
  }

  async json(path, options = {}) {
    const { response, payload } = await this.auth.json(path, options);
    if (!response.ok) throw errorFor(response, payload);
    return payload;
  }

  async ensureCliSession(expectedWallet) {
    if (!this.auth.hasPersistedCredentials()) throw new FinchipAuthError('SESSION_REAUTH_REQUIRED', 'Run `finchip login` before continuing this Task.', 2);
    let session;
    try { session = await this.auth.getSession(); } catch (error) { throw error; }
    if (!session.authenticated || !session.account || !session.wallet) {
      this.auth.clearCredentials();
      throw new FinchipAuthError('SESSION_REAUTH_REQUIRED', 'FinChip CLI session is expired or revoked. Run `finchip login`.', 2);
    }
    if (session.account.clientKind !== 'cli' || session.wallet.clientKind !== 'cli') {
      throw new FinchipAuthError('SESSION_REAUTH_REQUIRED', 'The saved credentials are not a CLI session. Run `finchip login`.', 2);
    }
    if (session.authMode !== 'agent_cli' || session.account.authMode !== 'agent_cli' || session.wallet.authMode !== 'agent_cli') {
      throw new FinchipAuthError('SESSION_REAUTH_REQUIRED', 'The saved credentials are not an Agent CLI session. Run `finchip login`.', 2);
    }
    if (expectedWallet && session.wallet.walletAddr?.toLowerCase() !== expectedWallet.toLowerCase()) {
      throw new FinchipAuthError('WALLET_MISMATCH', 'FinChip CLI session wallet does not match the selected Agent wallet.', 3);
    }
    return session;
  }

  config() { return this.json('/api/action-intents/config'); }
  list(status) { return this.json(`/api/action-intents${status ? `?status=${encodeURIComponent(status)}` : ''}`); }
  show(id) { return this.json(`/api/action-intents/${id}`); }
  claim(id, claimSecret = null) {
    const body = { cliVersion: this.cliVersion };
    if (claimSecret) body.claimSecret = claimSecret;
    return this.json(`/api/action-intents/${id}/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  heartbeat(id) { return this.json(`/api/action-intents/${id}/heartbeat`, { method: 'POST' }); }
  putPlan(id, plan) { return this.json(`/api/action-intents/${id}/execution-plan`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(plan) }); }
  decide(id, decision, planHash, reasonCode) { return this.json(`/api/action-intents/${id}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, planHash, reasonCode }) }); }
  beginBroadcast(id, planHash, broadcastAttemptId) { return this.json(`/api/action-intents/${id}/broadcast-attempt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planHash, broadcastAttemptId }) }); }
  recordBroadcast(id, txHash) { return this.json(`/api/action-intents/${id}/broadcast`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txHash }) }); }
  resultUnknown(id, txHash = null) { return this.json(`/api/action-intents/${id}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ result: 'result_unknown', txHash }) }); }
  recheck(id) { return this.json(`/api/action-intents/${id}/recheck`, { method: 'POST' }); }
  deny(id, planHash, reasonCode) { return this.decide(id, 'deny', planHash, reasonCode); }
  beginStep(id, stepIndex, planHash, attemptId) {
    return this.json(`/api/action-intents/${id}/steps/${stepIndex}/attempt`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planHash, attemptId }),
    });
  }
  recordStepResult(id, stepIndex, attemptId, result) {
    return this.json(`/api/action-intents/${id}/steps/${stepIndex}/result`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attemptId, ...result }),
    });
  }

  async assertCompatible() {
    const config = await this.config();
    const actionsMatch = Array.isArray(config.supportedActions)
      && SUPPORTED_ACTION_INTENT_KINDS.every(kind => config.supportedActions.includes(kind));
    if (config.schemaHash !== ACTION_INTENT_SCHEMA_HASH || !actionsMatch || !isCliVersionSupported(this.cliVersion, config.minimumCliVersion)) {
      throw new FinchipAuthError('CLIENT_VERSION_UNSUPPORTED', 'Site Action Intent contract is not compatible with this CLI.', 3);
    }
    return config;
  }
}
