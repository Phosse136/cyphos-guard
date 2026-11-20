/** Terminal transcript for the demo: what Claude says, which tools it calls, and what phoswallet decided. */
import type { ToolEvent } from "./tools.ts";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

export function createPrinter({ live }: { live: boolean }) {
  const tx = (h: string) => (live ? `https://sepolia.basescan.org/tx/${h}` : h);
  return {
    text(t: string) {
      console.log(`\n${c.cyan("Claude")}  ${t.trim().replace(/\n/g, "\n        ")}`);
    },
    event(e: ToolEvent) {
      if ("kind" in e) {
        const line = {
          paid: () => c.green(`  ✔ ${e.invoiceId} paid by the agent alone (within limits)  ${tx(e.detail)}`),
          approved_paid: () =>
            c.green(`  ✔ ${e.invoiceId} approved with the owner's passkey, then paid  ${tx(e.detail)}`),
          pending: () => c.yellow(`  ⏳ ${e.invoiceId} above the agent's limits: approval requested from the owner`),
          denied: () => c.red(`  ✘ ${e.invoiceId} blocked by policy (${e.detail})`),
          rejected: () => c.red(`  ✘ ${e.invoiceId} rejected by the owner`),
          failed: () => c.red(`  ✘ ${e.invoiceId} failed: ${e.detail}`),
        }[e.outcome]();
        console.log(line);
        return;
      }
      const args = JSON.stringify(e.input);
      console.log(c.dim(`  → ${e.tool}(${args.length > 120 ? `${args.slice(0, 117)}...` : args})`));
    },
    heading(s: string) {
      console.log(`\n${c.bold(s)}`);
    },
    owner(s: string) {
      console.log(c.bold(`\n👤 Owner  ${s}`));
    },
  };
}
