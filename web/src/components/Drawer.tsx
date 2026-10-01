import type { ReactNode } from "react";
import { createPortal } from "react-dom";

// Right slide-over drawer (docs/UI.md §4). Forms and detail views keep the list visible behind.
// Portaled to body: clip-path on ancestors (chamfer panels) would otherwise trap
// position:fixed inside their containing block.
export function Drawer({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  if (typeof document === "undefined") return null; // SSR renderToString

  return createPortal(
    <div
      className={`fixed inset-0 z-40 transition-[visibility] duration-200 ${open ? "visible" : "invisible"}`}
      aria-hidden={!open}
    >
      <button
        type="button"
        aria-label="Close drawer"
        onClick={onClose}
        className={`absolute inset-0 bg-crust/60 transition-opacity duration-200 ${open ? "opacity-100" : "opacity-0"}`}
      />
      <aside
        className={`absolute top-0 right-0 flex h-full w-full max-w-md flex-col border-l border-surface0 bg-mantle transition-transform duration-200 ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
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
      </aside>
    </div>,
    document.body,
  );
}
