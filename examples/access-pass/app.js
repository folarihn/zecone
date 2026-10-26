// Access Pass frontend. Talks only to its own merchant server; never holds a
// ZecOne API key or webhook secret. Content is requested from the server, which
// unlocks it only after verifying settlement. Nothing here can mark an order paid.
const $ = (id) => document.getElementById(id);
const BASE = 8453;
const BASE_SEPOLIA = 84532;
let config = null;
let account = null;
let chainId = null;
let order = null;
let pollTimer = null;

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 403) throw new Error(data.error?.message || `Request failed (${res.status})`);
  return { status: res.status, data };
}

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const toHex = (s) => "0x" + Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");

// ---------------- merchant setup ----------------
function renderWallet() {
  $("wallet").textContent = account ? short(account) : "not connected";
  const onBase = chainId === BASE || chainId === BASE_SEPOLIA;
  $("network").textContent = chainId === null ? "—" : onBase ? (chainId === BASE ? "Base" : "Base Sepolia") : `Unsupported (${chainId})`;
  $("switch").classList.toggle("hidden", !account || onBase);
  $("connect").classList.toggle("hidden", !!account);
  $("sign").disabled = !account || !onBase;
}

async function connect() {
  $("setup-error").textContent = "";
  if (!window.ethereum) return ($("setup-error").textContent = "No browser wallet found. Install Coinbase Wallet or MetaMask.");
  try {
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    account = accounts[0];
    chainId = Number(await window.ethereum.request({ method: "eth_chainId" }));
    renderWallet();
  } catch (e) {
    $("setup-error").textContent = e.code === 4001 ? "Request rejected in your wallet." : e.message;
  }
}

async function switchToBase() {
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] });
  } catch (e) {
    if (e.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: "0x2105", chainName: "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://mainnet.base.org"], blockExplorerUrls: ["https://basescan.org"] }],
      });
    } else {
      $("setup-error").textContent = e.message;
    }
  }
  chainId = Number(await window.ethereum.request({ method: "eth_chainId" }));
  renderWallet();
}

async function signAndConnect() {
  $("setup-error").textContent = "";
  $("sign").disabled = true;
  $("sign").textContent = "Waiting for signature…";
  try {
    const { data: challenge } = await api("/api/setup/challenge", { address: account, chainId });
    const signature = await window.ethereum.request({ method: "personal_sign", params: [toHex(challenge.message), account] });
    await api("/api/setup/verify", { message: challenge.message, signature });
    await loadConfig();
  } catch (e) {
    $("setup-error").textContent = e.code === 4001 ? "Signature rejected in your wallet." : e.message;
  } finally {
    $("sign").textContent = "Sign and connect to ZecOne";
    renderWallet();
  }
}

async function loadConfig() {
  const { data } = await api("/api/config");
  config = data;
  $("price").textContent = `$${data.product.amountUsd}`;
  $("setup-status").textContent = data.configured ? "Connected to ZecOne." : "Not connected to ZecOne yet.";
  $("setup-form").classList.toggle("hidden", data.configured);
  $("setup-done").classList.toggle("hidden", !data.configured);
  if (data.configured) {
    $("m-name").textContent = data.merchant.name;
    $("m-payout").textContent = data.merchant.payoutAddress;
  }
  $("buy").disabled = !data.configured;
}

// ---------------- buying ----------------
const ORDER_STEPS = ["AWAITING_PAYMENT", "VERIFYING", "ZEC_CONFIRMED", "PAYOUT_CONFIRMED", "COMPLETED"];
const RANK = {
  CREATED: 0, QUOTED: 0, AWAITING_PAYMENT: 0, PAYMENT_DETECTED: 1, VERIFYING: 1, ZEC_CONFIRMED: 2,
  PAYOUT_PENDING: 2, PAYOUT_SUBMITTED: 2, PAYOUT_CONFIRMED: 3, COMPLETED: 4,
};

function renderSteps(paymentState, paid) {
  const rank = paid ? 5 : RANK[paymentState] ?? 0;
  document.querySelectorAll("#steps li").forEach((li, i) => {
    li.classList.toggle("done", i < rank || (i === 4 && paid));
    li.classList.toggle("active", i === rank && !paid);
  });
}

async function buy() {
  $("buy-error").textContent = "";
  $("buy").disabled = true;
  try {
    const { data } = await api("/api/orders", {});
    order = data;
    $("checkout").classList.remove("hidden");
    $("embed").src = data.embedUrl;
    $("hosted-link").href = data.hostedUrl;
    $("buy").textContent = "Order created";
    renderSteps("AWAITING_PAYMENT", false);
    poll();
  } catch (e) {
    $("buy-error").textContent = e.message;
    $("buy").disabled = false;
  }
}

async function poll() {
  clearTimeout(pollTimer);
  if (!order) return;
  try {
    const { data } = await api(`/api/orders/${order.orderId}`);
    renderSteps(data.paymentState, data.status === "paid");
    if (data.status === "paid") return unlock();
    if (data.status === "expired") {
      $("buy-error").textContent = "This order expired before payment. Start a new one.";
      $("buy").disabled = false;
      $("buy").textContent = "Buy with ZEC";
      return;
    }
  } catch {
    /* transient */
  }
  pollTimer = setTimeout(poll, 1500);
}

async function unlock() {
  const { status, data } = await api(`/api/content?order=${encodeURIComponent(order.orderId)}`);
  if (status !== 200 || !data.unlocked) {
    pollTimer = setTimeout(poll, 1500);
    return;
  }
  $("locked").classList.add("hidden");
  $("unlocked").classList.remove("hidden");
  $("c-title").textContent = data.content.title;
  $("c-body").textContent = data.content.body;
  $("c-evidence").textContent = data.content.evidence;
  if (data.content.payoutTx) {
    $("c-tx").textContent = `Base payout: ${data.content.payoutTx}`;
    $("c-tx").href = `https://basescan.org/tx/${data.content.payoutTx}`;
  }
}

// The embedded checkout posts status messages; they only trigger an early
// re-check with OUR server — they are never trusted as proof of payment.
window.addEventListener("message", (e) => {
  if (!config || e.origin !== new URL(config.zeconeWeb).origin) return;
  if (e.data?.source === "zecone-checkout" && order && e.data.paymentId === order.paymentId) poll();
});

function tab(which) {
  const embed = which === "embed";
  $("tab-embed").setAttribute("aria-selected", String(embed));
  $("tab-hosted").setAttribute("aria-selected", String(!embed));
  $("embed").classList.toggle("hidden", !embed);
  $("hosted").classList.toggle("hidden", embed);
}

$("connect").addEventListener("click", connect);
$("switch").addEventListener("click", switchToBase);
$("sign").addEventListener("click", signAndConnect);
$("buy").addEventListener("click", buy);
$("tab-embed").addEventListener("click", () => tab("embed"));
$("tab-hosted").addEventListener("click", () => tab("hosted"));
if (window.ethereum?.on) {
  window.ethereum.on("accountsChanged", (a) => { account = a[0] ?? null; renderWallet(); });
  window.ethereum.on("chainChanged", (c) => { chainId = Number(c); renderWallet(); });
}
loadConfig().catch((e) => ($("setup-status").textContent = `Merchant server error: ${e.message}`));
