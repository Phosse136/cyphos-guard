import {
  type Address,
  type EIP1193Provider,
  formatEther,
  formatUnits,
  getAddress,
  isAddress,
  isAddressEqual,
} from "viem";
import {
  type AccountState,
  buildUserOp,
  CHAIN,
  encodeBatchExecute,
  inspect,
  signAndSubmit,
  withdrawAllCalls,
} from "./recovery.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const connectBtn = $<HTMLButtonElement>("connect");
const checkBtn = $<HTMLButtonElement>("check");
const withdrawBtn = $<HTMLButtonElement>("withdraw");
const accountInput = $<HTMLInputElement>("account");
const connectedEl = $("connected");
const stateEl = $("state");
const resultEl = $("result");

const provider = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
let recovery: Address | null = null;
let state: AccountState | null = null;

const msg = (el: HTMLElement, kind: "ok" | "bad" | "info", text: string, link?: { href: string; label: string }) => {
  el.replaceChildren();
  const p = document.createElement("p");
  p.className = `msg ${kind}`;
  p.textContent = text;
  if (link) {
    const a = document.createElement("a");
    a.href = link.href;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = ` ${link.label}`;
    p.append(a);
  }
  el.append(p);
  el.classList.remove("hidden");
};
const errText = (e: unknown) => {
  const m = (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message ?? String(e);
  return m.split("\n")[0] ?? m;
};
const refresh = () => {
  checkBtn.disabled = !recovery || !isAddress(accountInput.value.trim());
  withdrawBtn.disabled =
    !recovery ||
    !state?.recovery ||
    !isAddressEqual(state.recovery, recovery) ||
    (state.eth === 0n && state.usdc === 0n && state.deposit === 0n);
};

async function ensureChain(p: EIP1193Provider) {
  const hex = `0x${CHAIN.id.toString(16)}`;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await p.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hex,
          chainName: "Base Sepolia",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: ["https://sepolia.base.org"],
          blockExplorerUrls: ["https://sepolia.basescan.org"],
        },
      ],
    });
  }
}

connectBtn.addEventListener("click", async () => {
  if (!provider) {
    msg(
      connectedEl,
      "bad",
      "No wallet found. Open this page in a browser with MetaMask (or another wallet) installed.",
    );
    return;
  }
  try {
    const [addr] = (await provider.request({ method: "eth_requestAccounts" })) as string[];
    if (!addr) throw new Error("no account");
    await ensureChain(provider);
    recovery = getAddress(addr);
    msg(connectedEl, "ok", `Connected: ${recovery} (Base Sepolia)`);
    connectBtn.textContent = "Connected";
  } catch (e) {
    msg(connectedEl, "bad", `Could not connect: ${errText(e)}`);
  }
  refresh();
});

accountInput.addEventListener("input", () => {
  state = null;
  stateEl.classList.add("hidden");
  refresh();
});

checkBtn.addEventListener("click", async () => {
  if (!provider || !recovery) return;
  checkBtn.disabled = true;
  try {
    state = await inspect(provider, getAddress(accountInput.value.trim()));
    stateEl.replaceChildren();
    const dl = document.createElement("dl");
    for (const [k, v] of [
      ["USDC", `${formatUnits(state.usdc, 6)} USDC`],
      ["ETH", `${formatEther(state.eth)} ETH`],
      ["Gas deposit", `${formatEther(state.deposit)} ETH`],
      ["Recovery address", state.recovery ?? "none"],
    ] as const) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      if (k === "Recovery address") dd.className = "mono";
      dl.append(dt, dd);
    }
    stateEl.append(dl);
    stateEl.classList.remove("hidden");
    const note = document.createElement("div");
    stateEl.append(note);
    if (!state.deployed) msg(note, "bad", "No smart account at this address on Base Sepolia.");
    else if (!state.recovery)
      msg(note, "bad", "This account has no recovery address. Only its passkey can move funds.");
    else if (!isAddressEqual(state.recovery, recovery))
      msg(note, "bad", "The connected wallet is not this account's recovery address. Connect the right wallet.");
    else if (state.eth === 0n && state.usdc === 0n && state.deposit === 0n) msg(note, "info", "The account is empty.");
    else msg(note, "ok", "Your wallet is this account's recovery address. You can withdraw.");
  } catch (e) {
    msg(stateEl, "bad", `Could not read the account: ${errText(e)}`);
  }
  refresh();
});

withdrawBtn.addEventListener("click", async () => {
  if (!provider || !recovery || !state) return;
  withdrawBtn.disabled = true;
  try {
    msg(resultEl, "info", "Step 1 of 2: sign the withdrawal in your wallet…");
    const op = await buildUserOp(provider, state.account, encodeBatchExecute(withdrawAllCalls(state, recovery)));
    const signing = signAndSubmit(provider, recovery, op);
    setTimeout(() => {
      if (resultEl.textContent?.startsWith("Step 1"))
        msg(resultEl, "info", "Step 2 of 2: confirm the transaction in your wallet…");
    }, 4000);
    const hash = await signing;
    msg(resultEl, "ok", "Done. Everything was sent to your recovery address.", {
      href: `https://sepolia.basescan.org/tx/${hash}`,
      label: "View on Basescan ↗",
    });
  } catch (e) {
    msg(resultEl, "bad", `Withdrawal failed: ${errText(e)}`);
  }
  // Re-read and redraw the balances, so the page shows what is (or isn't) left.
  checkBtn.disabled = false;
  checkBtn.click();
});

const pre = new URLSearchParams(location.search).get("account");
if (pre && isAddress(pre)) accountInput.value = pre;
refresh();
