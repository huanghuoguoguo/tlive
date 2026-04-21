import { commandRegistry } from './registry.js';
import { StatusCommand } from './status.js';
import { NewCommand } from './new.js';
import { HomeCommand } from './home.js';
import { PermCommand } from './perm.js';
import { StopCommand } from './stop.js';
import { HooksCommand } from './hooks.js';
import { SessionCommand } from './session.js';
import { CdCommand } from './cd.js';
import { PwdCommand } from './pwd.js';
import { BashCommand } from './bash.js';
import { SettingsCommand } from './settings.js';
import { HelpCommand } from './help.js';
import { ApproveCommand } from './approve.js';
import { PairingsCommand } from './pairings.js';
import { UpgradeCommand } from './upgrade.js';
import { RestartCommand } from './restart.js';
import { QueueCommand } from './queue.js';
import { DiagnoseCommand } from './diagnose.js';
import { RebindCommand } from './rebind.js';
import { DoctorCommand } from './doctor.js';

/** Register all built-in commands */
export function registerAllCommands(): void {
  commandRegistry.register(new StatusCommand());
  commandRegistry.register(new NewCommand());
  commandRegistry.register(new HomeCommand());
  commandRegistry.register(new PermCommand());
  commandRegistry.register(new StopCommand());
  commandRegistry.register(new HooksCommand());
  commandRegistry.register(new SessionCommand());
  commandRegistry.register(new CdCommand());
  commandRegistry.register(new PwdCommand());
  commandRegistry.register(new BashCommand());
  commandRegistry.register(new SettingsCommand());
  commandRegistry.register(new HelpCommand());
  commandRegistry.register(new ApproveCommand());
  commandRegistry.register(new PairingsCommand());
  commandRegistry.register(new UpgradeCommand());
  commandRegistry.register(new RestartCommand());
  commandRegistry.register(new QueueCommand());
  commandRegistry.register(new DiagnoseCommand());
  commandRegistry.register(new RebindCommand());
  commandRegistry.register(new DoctorCommand());
}

export { commandRegistry } from './registry.js';