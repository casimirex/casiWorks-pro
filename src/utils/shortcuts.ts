// CasiWorks Pro - Keyboard shortcuts: key bindings run commands from the registry
import { shortcutFromEvent } from '../commands/CommandRegistry.ts';
import type { CommandRegistry } from '../commands/CommandRegistry.ts';

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return target.closest('input, select, textarea, [contenteditable="true"]') !== null;
}

/**
 * Install global keyboard shortcuts: each key combination bound by a command
 * (`shortcuts: ['Ctrl+S']`) runs that command. Returns a function that removes them.
 */
export function setupKeyboardShortcuts<S>(registry: CommandRegistry<S>, onError?: (message: string) => void): () => void {
  const handleKeyDown = (e: KeyboardEvent) => {
    // Ignore keystrokes while typing into inputs
    if (isTypingTarget(e.target)) return;
    const id = registry.commandForShortcut(shortcutFromEvent(e));
    if (!id) return;
    e.preventDefault();
    try {
      registry.execute(id);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
    }
  };

  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}
