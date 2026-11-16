// CasiWorks Pro - Reusable Numeric Input Component
// Provides a number input with increment/decrement buttons and unit suffix

import React, { useState, useCallback, useRef, useEffect } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { isPlainNumber, parseExpression } from '../../features/equations.ts';

export interface NumericInputProps {
  value?: number;
  onChange?: (value: number) => void;
  min?: number;
  max?: number;
  /** Increment/decrement step size. */
  step?: number;
  /** Unit suffix to display (e.g. 'mm', 'deg'). */
  unit?: string;
  /** Decimal precision. */
  precision?: number;
  disabled?: boolean;
  /** Accessible label. */
  label?: string;
  className?: string;
  /**
   * Equations: with `evaluate`, the field also takes an expression such as
   * `wall * 2` (or `=wall * 2`). One that uses variables stays linked: it is
   * reported through onExpressionChange, shown with ƒ, and edited as text.
   * Typing a number or using the spin buttons unlinks it.
   */
  evaluate?: (text: string) => number;
  expression?: string | null;
  onExpressionChange?: (expression: string | null) => void;
  /** Called with the reason when an expression cannot be evaluated. */
  onError?: (message: string) => void;
}

/** A numeric input with spin buttons and unit display. */
const NumericInput = ({
  value = 0,
  onChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  unit = '',
  precision = 4,
  disabled = false,
  label,
  className = '',
  evaluate,
  expression = null,
  onExpressionChange,
  onError,
}: NumericInputProps) => {
  // Internal string representation for editing
  const [editValue, setEditValue] = useState(String(value));
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // The text being edited, readable from timers without waiting for a re-render
  // (holding a spin button steps many times between renders)
  const editValueRef = useRef(editValue);
  editValueRef.current = editValue;

  /** Format a numeric value for display (trailing zeros removed, up to `precision` decimals) */
  const formatValue = useCallback((val: number | null | undefined) => {
    if (val === null || val === undefined || Number.isNaN(Number(val))) return '0';
    return parseFloat(Number(val).toFixed(precision)).toString();
  }, [precision]);

  // Sync display value with prop when not actively editing
  useEffect(() => {
    if (!isEditing) {
      setEditValue(formatValue(value));
    }
  }, [value, isEditing, formatValue]);

  /** Clamp a value between min and max */
  const clamp = useCallback((val: number) => {
    return Math.min(max, Math.max(min, val));
  }, [min, max]);

  /** Commit the current edit value */
  const commitValue = useCallback(() => {
    // Read the latest text: a blur can arrive before React re-renders after the last keystroke
    const text = editValueRef.current;
    if (evaluate && text.trim() && !isPlainNumber(text)) {
      try {
        const result = clamp(evaluate(text));
        const expr = text.trim().replace(/^=\s*/, '');
        // Keep the link only when it uses variables; plain arithmetic is just a number
        onExpressionChange?.(parseExpression(expr).names.size > 0 ? expr : null);
        setEditValue(formatValue(result));
        if (result !== value) onChange?.(result);
      } catch (err) {
        setEditValue(formatValue(value));
        onError?.(err instanceof Error ? err.message : String(err));
      }
      setIsEditing(false);
      return;
    }
    if (expression && text.trim() !== `=${expression}`) onExpressionChange?.(null);
    const parsed = parseFloat(text);
    if (isNaN(parsed)) {
      setEditValue(formatValue(value));
    } else {
      const clamped = clamp(parsed);
      setEditValue(formatValue(clamped));
      if (clamped !== value && onChange) {
        onChange(clamped);
      }
    }
    setIsEditing(false);
  }, [value, clamp, onChange, formatValue, evaluate, expression, onExpressionChange, onError]);

  /** Handle text input change */
  const handleInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    editValueRef.current = e.target.value;
    setEditValue(e.target.value);
  }, []);

  /** Handle focus - select all text for easy replacement */
  const handleFocus = useCallback(() => {
    setIsEditing(true);
    // A linked field is edited as its expression
    if (expression) {
      editValueRef.current = `=${expression}`;
      setEditValue(`=${expression}`);
    }
    // Select all text after a tiny delay so the DOM has time to update
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.select();
      }
    }, 0);
  }, [expression]);

  /** Handle blur - commit value */
  const handleBlur = useCallback(() => {
    commitValue();
  }, [commitValue]);

  /** Handle keyboard events */
  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    // Stop typing/arrow keys from propagating to global shortcuts (L, R, C, D, Space, etc.)
    e.stopPropagation();

    if (e.key === 'Enter') {
      commitValue();
      inputRef.current?.blur();
    } else if (e.key === 'Escape') {
      setEditValue(formatValue(value));
      setIsEditing(false);
      inputRef.current?.blur();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      // Stepping sets a number: the field is no longer linked
      const base = expression ? value : (parseFloat(editValueRef.current) || 0);
      if (expression) onExpressionChange?.(null);
      const newVal = clamp(base + step);
      editValueRef.current = formatValue(newVal);
      setEditValue(formatValue(newVal));
      onChange?.(newVal);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      // Stepping sets a number: the field is no longer linked
      const base = expression ? value : (parseFloat(editValueRef.current) || 0);
      if (expression) onExpressionChange?.(null);
      const newVal = clamp(base - step);
      editValueRef.current = formatValue(newVal);
      setEditValue(formatValue(newVal));
      onChange?.(newVal);
    }
  }, [commitValue, value, clamp, step, onChange, formatValue, expression, onExpressionChange]);

  /** Step the value up (+1) or down (−1) from the latest edit value */
  const stepBy = useCallback((sign: 1 | -1) => {
    // Stepping sets a number: the field is no longer linked
    if (expression) onExpressionChange?.(null);
    const current = expression ? value : (parseFloat(editValueRef.current) || 0);
    const newVal = clamp(current + sign * step);
    const text = formatValue(newVal);
    editValueRef.current = text;
    setEditValue(text);
    onChange?.(newVal);
  }, [step, clamp, onChange, formatValue, expression, onExpressionChange, value]);

  /** Start holding a spin button for continuous adjustment */
  const startHold = useCallback((direction: 'up' | 'down') => {
    const fn = () => stepBy(direction === 'up' ? 1 : -1);
    fn();
    holdTimerRef.current = setTimeout(() => {
      holdIntervalRef.current = setInterval(fn, 80);
    }, 400);
  }, [stepBy]);

  /** Stop holding */
  const stopHold = useCallback(() => {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    if (holdIntervalRef.current) clearInterval(holdIntervalRef.current);
    holdTimerRef.current = null;
    holdIntervalRef.current = null;
  }, []);

  // Clean up hold timers on unmount
  useEffect(() => {
    return () => stopHold();
  }, [stopHold]);

  return (
    <div className={`numeric-input-wrapper ${disabled ? 'disabled' : ''} ${expression ? 'linked' : ''} ${className}`} title={expression ? `= ${expression}` : undefined}>
      {expression && !isEditing && <span className="numeric-linked-tag" aria-label={`Linked: ${expression}`}>ƒ</span>}
      <input
        ref={inputRef}
        className="numeric-input-field"
        type="text"
        value={editValue}
        onChange={handleInputChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        aria-label={label || 'Numeric input'}
      />
      {unit && <span className="numeric-unit-tag">{unit}</span>}
      <div className="spin-buttons">
        <button
          className="spin-btn"
          onPointerDown={(e) => { e.preventDefault(); startHold('up'); }}
          onPointerUp={stopHold}
          onPointerLeave={stopHold}
          onPointerCancel={stopHold}
          disabled={disabled}
          tabIndex={-1}
          aria-label="Increment"
        >
          <ChevronUp size={10} />
        </button>
        <button
          className="spin-btn"
          onPointerDown={(e) => { e.preventDefault(); startHold('down'); }}
          onPointerUp={stopHold}
          onPointerLeave={stopHold}
          onPointerCancel={stopHold}
          disabled={disabled}
          tabIndex={-1}
          aria-label="Decrement"
        >
          <ChevronDown size={10} />
        </button>
      </div>
    </div>
  );
};

export default React.memo(NumericInput);
