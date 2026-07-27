import { CliError, emitFailure } from './utils.js';

export function requireExplicitConfirmation(options, { code, action }) {
  if (options?.yes) return true;
  emitFailure(
    options,
    new CliError(
      code,
      `[${code}] Re-run with --yes to ${action}.`,
      3,
      { confirmationRequired: true }
    )
  );
  return false;
}
