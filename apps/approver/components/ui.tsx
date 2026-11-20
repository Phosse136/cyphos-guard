import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Card({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "danger" | "ghost" }) {
  const styles = {
    primary: "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200",
    danger: "bg-red-600 text-white hover:bg-red-500",
    ghost: "border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800",
  }[variant];
  return (
    <button
      type="button"
      {...props}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children and nested inside the label
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 font-mono text-sm dark:border-zinc-700";

export function ErrorText({ error }: { error: string | null }) {
  return error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null;
}

/** Copy-to-clipboard button (localhost is a secure context, so the Clipboard API works). */
export function CopyButton({ value }: { value: string }) {
  return (
    <button
      type="button"
      title="Copy"
      className="ml-1 rounded px-1 text-xs text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700"
      onClick={() => navigator.clipboard?.writeText(value)}
    >
      copy
    </button>
  );
}

/** Full address, monospace, copyable. */
export function Addr({ value, label }: { value: string; label?: string }) {
  return (
    <span className="break-all font-mono text-xs">
      {label && <span className="mr-1 font-sans text-zinc-500">{label}</span>}
      {value}
      <CopyButton value={value} />
    </span>
  );
}

/** Full tx hash, copyable, with a Basescan link on live networks. */
export function TxHash({ hash, fork }: { hash: string; fork: boolean }) {
  return (
    <span className="break-all font-mono text-xs">
      {fork ? (
        hash
      ) : (
        <a className="underline" href={`https://sepolia.basescan.org/tx/${hash}`} target="_blank" rel="noreferrer">
          {hash}
        </a>
      )}
      <CopyButton value={hash} />
      {fork && <span className="ml-1 font-sans text-zinc-400">(local fork)</span>}
    </span>
  );
}

/** Two-column detail list. */
export function Details({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-zinc-500">{k}</dt>
          <dd className="min-w-0">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Badge({ children, tone = "zinc" }: { children: ReactNode; tone?: "zinc" | "green" | "amber" | "red" }) {
  const styles = {
    zinc: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    green: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
    amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    red: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  }[tone];
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${styles}`}>{children}</span>;
}
