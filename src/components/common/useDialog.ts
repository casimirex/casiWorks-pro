// CasiWorks Pro - Accessible modal dialogs
//
// Spread the returned props on the dialog box: it is announced as a modal
// dialog with a name, focus moves into it when it opens (the first field, else
// the first button), Tab and Shift+Tab stay inside it, Escape closes it, and
// focus returns to whatever had it before (the button that opened it).
import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, RefCallback } from 'react';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const focusables = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => el.offsetParent !== null || el === document.activeElement);

export interface DialogProps {
  ref: RefCallback<HTMLDivElement>;
  role: 'dialog';
  'aria-modal': true;
  'aria-label': string;
  onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void;
}

export function useDialog(isOpen: boolean, onClose: () => void, label: string): DialogProps {
  const box = useRef<HTMLDivElement | null>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    opener.current = document.activeElement;
    const el = box.current;
    if (el) {
      const all = focusables(el);
      const field = all.find(f => f.matches('input, select, textarea'));
      (field ?? all.find(f => !f.closest('.dialog-header')) ?? all[0] ?? el).focus();
    }
    return () => {
      const back = opener.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, [isOpen]);

  const ref = useCallback<RefCallback<HTMLDivElement>>((el) => {
    box.current = el;
    if (el && !el.hasAttribute('tabindex')) el.tabIndex = -1; // focusable as a last resort
  }, []);

  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !box.current) return;
    const all = focusables(box.current);
    if (all.length === 0) { e.preventDefault(); return; }
    const first = all[0], last = all[all.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !box.current.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !box.current.contains(active))) { e.preventDefault(); first.focus(); }
  }, [onClose]);

  return { ref, role: 'dialog', 'aria-modal': true, 'aria-label': label, onKeyDown };
}
