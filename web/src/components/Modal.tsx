import type { ReactNode } from "react";
import { createPortal } from "react-dom";

// Centered modal for read-focused detail views (drawers stay for forms).
// Portaled to body for the same clip-path reason as Drawer.
export function Modal({
  title,
  open,
  onClose,
  children,
  wide,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  if (typeof document === "undefined") return null; // SSR renderToString

  return createPortal(
    <div
      className={`fixed inset-0 z-40 flex items-center justify-center transition-[visibility] duration-150 ${open ? "visible" : "invisible"}`}
      aria-hidden={!open}
    >
      <button
        type="button"
        aria-label="Close modal"
        onClick={onClose}
        className={`absolute inset-0 bg-crust/70 transition-opacity duration-150 ${open ? "opacity-100" : "opacity-0"}`}
      />
      <div
        role="dialog"
        aria-label={title}
        className={`chamfer relative z-10 mx-4 flex max-h-[85vh] flex-col bg-transparent [--chamfer-line:var(--color-surface1)] [--chamfer-bg:var(--color-base)] ${
          wide ? "w-full max-w-3xl" : "w-full max-w-xl"
        } border-0 transition-all duration-150 ${open ? "scale-100 opacity-100" : "scale-95 opacity-0"}`}
      >
        <div className="flex items-center justify-between border-b border-surface0 px-4 py-3">
          <div className="micro-label">{title}</div>
          <button
            type="button"
            onClick={onClose}
            className="px-2 font-mono text-subtext0 transition-colors duration-150 hover:text-text"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
