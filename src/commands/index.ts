// CasiWorks Pro - The application's command registry
//
// One registry for the running app: the ribbon, status bar, keyboard
// shortcuts and the public API (`casiworks.commands`) all execute through it.
import { useCADStore } from '../store/cadStore.ts';
import { createCommandRegistry } from './builtinCommands.ts';
import { attachMacros } from './macros.ts';

export * from './CommandRegistry.ts';
export { BUILTIN_COMMANDS, createCommandRegistry } from './builtinCommands.ts';
export * from './macros.ts';

export const commands = createCommandRegistry(useCADStore);
/** Records and replays commands of the app's registry (macro.* commands). */
export const macroRecorder = attachMacros(commands);

/**
 * Run a command from a UI control: failures are shown in the status bar
 * instead of being thrown into React event handlers.
 */
export function runCommand(id: string, args?: unknown): void {
  try {
    commands.execute(id, args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    useCADStore.getState().setStatus(message);
  }
}
