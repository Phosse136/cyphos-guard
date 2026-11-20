# Demo video script (about 1:45)

Setup before recording: `.env` has `ANTHROPIC_API_KEY`; `pnpm dev` is running; the browser is on
http://localhost:3000 with a fresh fork (restart `pnpm dev` and delete `apps/policy-service/policy-service.sqlite*`
for a clean slate). Screen layout: browser left, terminal right. Use a real passkey (Touch ID / Windows Hello) so the
prompt is visible.

| Time | On screen                                                                                                      | Voice-over                                                                                                                                                              |
| ---- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00 | Title card: "cyphos-guard: guardrails for AI agents that spend money"                                          | "AI agents are starting to pay for things. Today you either hand them a private key, or you click approve on every payment. cyphos-guard is the middle ground."         |
| 0:10 | Approver: **Create passkey** → Touch ID → **Create account**                                                   | "I create a smart account owned by my passkey. No seed phrase. cyphos-guard never holds a key to it."                                                                   |
| 0:22 | Terminal: `pnpm demo:setup` → open the prefill link → grant form                                               | "My accounts-payable agent gets a budget: up to 2 USDC per payment, 5 a day, to my inference provider. A little ETH for GPU credits. And one vendor I never want paid." |
| 0:35 | Click **Grant (sign with passkey)** → Touch ID → agent row appears                                             | "One passkey tap. These limits are enforced on-chain by the wallet itself, not by a server I have to trust."                                                            |
| 0:45 | Terminal: `pnpm demo:agent`. Claude lists invoices, checks balances; two green "paid by the agent alone" lines | "Claude reads the invoices and pays the routine ones on its own. No popup, no human."                                                                                   |
| 1:00 | Yellow line "INV-1043 above the agent's limits"; approver shows **Pay 4 USDC** with the agent's reason         | "The annual plan is 4 USDC, above its per-payment limit. So instead of failing, it asks me. I see exactly what will be paid, to whom, and why."                         |
| 1:12 | Click **Approve** → Touch ID → terminal: "approved with the owner's passkey, then paid"                        | "I approve with my passkey. That signs a one-time permission for exactly this payment. It can't be reused or changed."                                                  |
| 1:22 | Terminal: red line "INV-1044 blocked by policy (forbidden)"; approver activity shows **Blocked by policy**     | "The last invoice is from a vendor on my denylist. Claude tries to pay it, and cyphos-guard blocks it. I'm never even asked."                                           |
| 1:32 | Approver: click **Revoke** → Touch ID → "revoked"                                                              | "And if I ever stop trusting the agent: one click, one passkey tap, revoked on-chain. No cyphos-guard server needed."                                                   |
| 1:42 | End card: repo URL, "testnet only, open source"                                                                | "cyphos-guard: open source, testnet today. Guardrails for agents that spend money."                                                                                     |

## Shot checklist

- Terminal font ≥ 16 pt. Hide the `.env` file and never show the terminal scrollback of `demo:setup` beyond the
  agent address (the key itself is never printed).
- If Claude's wording differs from the script, keep the take. The colored outcome lines come from cyphos-guard, not
  from the model, and they're what the voice-over refers to.
- Fallback without an API key: `pnpm e2e:demo` records the same flow with a scripted model, with screenshots in
  `apps/approver/e2e/screenshots/`. Say on screen that the model is scripted.
