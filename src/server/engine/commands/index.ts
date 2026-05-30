import { commandRegistry } from './registry.js';
import { StatusCommand } from './status.js';
import { NewCommand } from './new.js';
import {
  ClientUpgradeCommand,
  HomeCommand,
  HomeDirectoryCommand,
  HomeHistoryCommand,
  HomeRefreshCommand,
  HomeTopicsCommand,
  HomeViewCommand,
  TliveCommand,
} from './home.js';
import { PermCommand } from './perm.js';
import { StopCommand } from './stop.js';
import { ContinueSessionCommand } from './continue.js';
import { CdCommand } from './cd.js';
import { PwdCommand } from './pwd.js';
import { BashCommand } from './bash.js';
import { SettingsCommand } from './settings.js';
import { HelpCommand } from './help.js';
import { UpgradeCommand } from './upgrade.js';
import { RestartCommand } from './restart.js';
import { DiagnoseCommand } from './diagnose.js';
import { UseCommand } from './use.js';

/** Register all built-in commands */
export function registerAllCommands(): void {
  commandRegistry.register(new StatusCommand());
  commandRegistry.register(new NewCommand());
  commandRegistry.register(new TliveCommand());
  commandRegistry.register(new HomeCommand());
  commandRegistry.register(new HomeViewCommand());
  commandRegistry.register(new HomeRefreshCommand());
  commandRegistry.register(new HomeDirectoryCommand());
  commandRegistry.register(new ClientUpgradeCommand());
  commandRegistry.register(new HomeTopicsCommand());
  commandRegistry.register(new HomeHistoryCommand());
  commandRegistry.register(new PermCommand());
  commandRegistry.register(new StopCommand());
  commandRegistry.register(new ContinueSessionCommand());
  commandRegistry.register(new CdCommand());
  commandRegistry.register(new PwdCommand());
  commandRegistry.register(new BashCommand());
  commandRegistry.register(new SettingsCommand());
  commandRegistry.register(new HelpCommand());
  commandRegistry.register(new UpgradeCommand());
  commandRegistry.register(new RestartCommand());
  commandRegistry.register(new DiagnoseCommand());
  commandRegistry.register(new UseCommand());
}

export { commandRegistry } from './registry.js';
