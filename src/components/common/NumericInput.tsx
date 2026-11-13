// CasiWorks Pro - Reusable Numeric Input Component
// Provides a number input with increment/decrement buttons and unit suffix

import React, { useState, useCallback, useRef, useEffect } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';

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
    const parsed = parseFloat(editValue);
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
  }, [editValue, value, clamp, onChange, formatValue]);

  /** Handle text input change */
  const handleInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setEditValue(e.target.value);
  }, []);

  /** Handle focus - select all text for easy replacement */
  const handleFocus = useCallback(() => {
    setIsEditing(true);
    // Select all text after a tiny delay so the DOM has time to update
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.select();
      }
    }, 0);
  }, []);

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
      const newVal = clamp((parseFloat(editValue) || 0) + step);
      setEditValue(formatValue(newVal));
      onChange?.(newVal);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const newVal = clamp((parseFloat(editValue) || 0) - step);
      setEditValue(formatValue(newVal));
      onChange?.(newVal);
    }
  }, [commitValue, value, clamp, step, editValue, onChange, formatValue]);

  /** Step the value up (+1) or down (−1) from the latest edit value */
  const stepBy = useCallback((sign: 1 | -1) => {
    const current = parseFloat(editValueRef.current) || 0;
    const newVal = clamp(current + sign * step);
    const text = formatValue(newVal);
    editValueRef.current = text;
    setEditValue(text);
    onChange?.(newVal);
  }, [step, clamp, onChange, formatValue]);

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
    <div className={`numeric-input ${disabled ? 'disabled' : ''} ${className}`}>
      <input
        ref={inputRef}
        type="text"
        value={editValue}
        onChange={handleInputChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        aria-label={label || 'Numeric input'}
      />
      {unit && <span className="unit-suffix">{unit}</span>}
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
