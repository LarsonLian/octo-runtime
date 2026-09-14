import { Fragment, type ReactNode } from "react";

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <Fragment>{children}</Fragment>;
}

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="group relative inline-flex">
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute right-0 top-full z-50 mt-1.5 hidden whitespace-nowrap border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] text-white shadow-lg group-hover:block group-focus-within:block"
      >
        {label}
      </span>
    </span>
  );
}
