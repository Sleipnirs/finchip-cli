import { CliError, emitFailure } from '../utils.js';

export function registerDeprecatedPublishCommands(program) {
  for (const name of ['launch', 'prepare']) {
    program
      .command(`${name} [legacyArgs...]`, { hidden: true })
      .description(`Deprecated: use finchip skill publish instead of ${name}`)
      .allowUnknownOption(true)
      .option('--json', 'Emit machine-readable JSON')
      .action((_legacyArgs, _options, command) => {
        const options = command.opts();
        emitFailure(options, new CliError(
          'COMMAND_DEPRECATED',
          `finchip ${name} is deprecated. Use finchip skill publish instead.`,
          3,
          { replacement: 'finchip skill publish' },
        ));
      });
  }
}
