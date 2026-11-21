import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import type { SessionStatus } from "@core/session/machine";
import markDark from "./assets/sada-mark-encre.svg";
import markGold from "./assets/sada-mark-or.svg";

/* Components taken from the Sada console (web/src/ui.tsx): same radii, borders and colors. */

export function Card({ children, className = "", ...rest }: { children: ReactNode; className?: string } & HTMLAttributes<HTMLElement>) {
  return (
    <section className={`rounded-[10px] border border-line bg-white p-4.5 ${className}`} {...rest}>
      {children}
    </section>
  );
}

export function Kicker({ children }: { children: ReactNode }) {
  return <p className="m-0 mb-2 text-[0.75rem] font-semibold uppercase leading-none tracking-[0.12em] text-green">{children}</p>;
}

export function Title({ children }: { children: ReactNode }) {
  return <h2 className="m-0 mb-2 font-serif text-[1.55rem] font-normal leading-[1.15] text-deeper">{children}</h2>;
}

type Variant = "plein" | "ghost" | "danger" | "dangerGhost" | "light";

export function Btn({
  children,
  variante = "plein",
  className = "",
  ...rest
}: { children: ReactNode; variante?: Variant } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const styles: Record<Variant, string> = {
    plein: "border-deep bg-deep text-white hover:bg-deeper",
    ghost: "border-deep bg-transparent text-deep hover:bg-paper-2",
    danger: "border-live bg-live text-white hover:bg-[#7f2122]",
    dangerGhost: "border-live/50 bg-transparent text-[#7f2122] hover:bg-err-bg",
    light: "border-white/25 bg-white/10 text-white hover:bg-white/18",
  };
  const look = rest.disabled ? "cursor-not-allowed border-line bg-paper-2 text-muted" : `cursor-pointer ${styles[variante]}`;
  return (
    <button
      type="button"
      className={`inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[9px] border px-4 py-2.5 font-semibold ${look} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Field({ label, help, children, className = "" }: { label: string; help?: string; children: ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-[0.9rem] font-semibold">{label}</span>
      {children}
      {help && <span className="mt-1 block text-[0.82rem] text-muted">{help}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-[#cfc6b0] bg-white px-3 py-2.5 text-ink disabled:bg-paper-2 disabled:text-muted";
export const selectClass = `${inputClass} select-chevron min-h-11`;

export function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-lg bg-err-bg px-3 py-2 text-[0.9rem] text-[#7a1f20]">
      {children}
    </p>
  );
}

export type PillKey = SessionStatus | "standby" | "armed";

const PILL: Record<PillKey, string> = {
  standby: "bg-paper-2 text-muted",
  armed: "bg-warn-bg text-warn",
  idle: "bg-paper-2 text-muted",
  connecting: "bg-warn-bg text-warn",
  live: "bg-live text-white",
  reconnecting: "bg-warn-bg text-warn",
  error: "bg-err-bg text-[#7a1f20]",
  stopping: "bg-paper-2 text-muted",
};

export function StatusPill({ status, label }: { status: PillKey; label: string }) {
  return (
    <span
      role="status"
      className={`inline-flex items-center gap-2 whitespace-nowrap rounded-full px-3.5 py-1 text-[0.9rem] font-bold ${PILL[status]}`}
    >
      <span
        aria-hidden
        className={`size-2 rounded-full ${status === "live" ? "animate-pulse bg-live-off" : status === "idle" || status === "stopping" || status === "standby" ? "bg-dot-off" : "bg-current"}`}
      />
      {label}
    </span>
  );
}

export function Brand({ dark = false }: { dark?: boolean }) {
  return (
    <span className="flex items-baseline gap-2.5">
      <img src={dark ? markGold : markDark} alt="Sadā" className={dark ? "h-6 w-auto" : "h-16 w-auto"} />
      <span className={`font-serif ${dark ? "text-[1.1rem] text-night-muted" : "sr-only"}`}>Studio</span>
    </span>
  );
}
