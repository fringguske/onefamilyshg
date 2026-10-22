"use client";
import type { ReactNode } from "react";
import { formatMoney } from "@/lib/money";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function Alert({ kind = "info", children }: { kind?: "info" | "error" | "success" | "warn"; children: ReactNode }) {
  return <div className={`alert alert-${kind}`} role={kind === "error" ? "alert" : "status"}>{children}</div>;
}

export function Stat({ label, cents, hint, strong }: { label: string; cents: number; hint?: string; strong?: boolean }) {
  return (
    <div className={`stat${strong ? " stat-strong" : ""}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value num">{formatMoney(cents)}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function Money({ cents, dashZero }: { cents: number; dashZero?: boolean }) {
  return <span className="num">{dashZero && !cents ? "–" : formatMoney(cents)}</span>;
}

export function Loading({ text = "Loading…" }: { text?: string }) {
  return <p className="muted loading">{text}</p>;
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn-icon" onClick={onClose} aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
