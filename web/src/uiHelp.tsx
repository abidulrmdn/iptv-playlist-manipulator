import { useState, type ReactNode } from "react";

/** Native tooltip for short explanations next to actions (hover or long-press on touch). */
export function InlineHelp({ text }: { text: string }) {
  return (
    <span
      className="ml-1 inline-flex h-5 w-5 shrink-0 cursor-help select-none items-center justify-center rounded-full border-2 border-zinc-400/50 bg-zinc-700/90 text-[10px] font-bold text-zinc-100 hover:border-zinc-300 hover:bg-zinc-600 hover:text-white"
      title={text}
      role="img"
      aria-label={text}
    >
      ?
    </span>
  );
}

type ExpandableHelpProps = {
  /** Short label shown in the always-visible summary row (e.g. “How this works”). */
  label: string;
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
  /** Visual weight: default = page hints; compact = tight rows (sidebar, toolbars). */
  variant?: "default" | "compact";
};

/**
 * Collapsible explanatory copy — keeps pages scannable; open when you need detail.
 * Uses native `<details>` for accessibility without extra React state.
 */
export function ExpandableHelp({ label, children, className = "", defaultOpen = false, variant = "default" }: ExpandableHelpProps) {
  const [open, setOpen] = useState(defaultOpen);
  const shell =
    variant === "compact"
      ? "rounded-lg border-2 border-zinc-400/40 bg-zinc-700/90 px-2.5 py-2 shadow-md shadow-black/15 ring-1 ring-zinc-950/25"
      : "rounded-xl border-2 border-zinc-400/40 bg-zinc-700/92 px-3 py-2.5 shadow-md shadow-black/15 ring-1 ring-zinc-950/25 sm:px-4 sm:py-3";

  return (
    <details
      className={`expandable-help group ${shell} ${className}`.trim()}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-left outline-none ring-emerald-500/30 focus-visible:rounded-md focus-visible:ring-2 [&::-webkit-details-marker]:hidden">
        <span
          className={
            variant === "compact"
              ? "text-xs font-medium text-zinc-200"
              : "text-sm font-medium text-zinc-100"
          }
        >
          {label}
        </span>
        <span
          className="shrink-0 text-zinc-400 transition-transform duration-200 group-open:rotate-180"
          aria-hidden
        >
          <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" className="inline-block">
            <path
              fillRule="evenodd"
              d="M5.22 8.22a.75.75 0 011.06 0L10 11.94l3.72-3.72a.75.75 0 111.06 1.06l-4.25 4.25a.75.75 0 01-1.06 0L5.22 9.28a.75.75 0 010-1.06z"
              clipRule="evenodd"
            />
          </svg>
        </span>
      </summary>
      <div
        className={
          variant === "compact"
            ? "mt-2 border-t-2 border-zinc-500/45 pt-2 text-xs leading-relaxed text-zinc-100 [&_strong]:font-medium [&_strong]:text-white"
            : "mt-3 border-t-2 border-zinc-500/45 pt-3 text-sm leading-relaxed text-zinc-100 [&_strong]:font-medium [&_strong]:text-white [&_ul]:mt-2 [&_ul]:space-y-2 [&_ul]:text-zinc-100"
        }
      >
        {children}
      </div>
    </details>
  );
}
