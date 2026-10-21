"use client";
// A submit button that asks "Are you sure?" in a small dialog before sending its form.
import { useRef, useState, type ReactNode } from "react";

export function ConfirmButton({ children, title, message, confirmLabel = "Yes, continue", className, danger, name, value }: {
  children: ReactNode; title: string; message?: string; confirmLabel?: string; className?: string; danger?: boolean; name?: string; value?: string;
}) {
  const [open, setOpen] = useState(false);
  const real = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>{children}</button>
      <button type="submit" ref={real} name={name} value={value} hidden />
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
            <h2>{title}</h2>
            {message && <p className="muted">{message}</p>}
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" className={danger ? "danger" : undefined} onClick={() => { setOpen(false); real.current?.form?.requestSubmit(real.current); }}>{confirmLabel}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
