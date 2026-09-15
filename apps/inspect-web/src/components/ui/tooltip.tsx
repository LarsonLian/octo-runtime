import { Fragment, type ReactNode } from "react";
import { cn } from "../../lib/utils";

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <Fragment>{children}</Fragment>;
}

export function Tooltip({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <span className={cn("group relative inline-flex", className)}>
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
