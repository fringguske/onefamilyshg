"use client";
import { parseMoney } from "@/lib/money";

/** A text box for money. Keeps exactly what was typed; the value is parsed to cents elsewhere. */
export function MoneyInput({
  value, onChange, label, disabled, id, placeholder = "0",
}: {
  value: string; onChange: (v: string) => void; label?: string; disabled?: boolean; id?: string; placeholder?: string;
}) {
  const invalid = parseMoney(value) === null;
  return (
    <input
      id={id}
      className={`money-input${invalid ? " invalid" : ""}`}
      inputMode="decimal"
      autoComplete="off"
      aria-label={label}
      aria-invalid={invalid}
      placeholder={placeholder}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
