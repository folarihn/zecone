import { ZecOneProvider } from "/zecone-provider.js";
const zec = new ZecOneProvider(),
  $ = (id) => document.getElementById(id);
const networkNames = Object.freeze({84532:"Base Sepolia",11155111:"Ethereum Sepolia",46630:"Robinhood Chain Testnet"});
const savedChain = Number(localStorage.getItem("zecone:network"));
let chainId = Object.hasOwn(networkNames, savedChain) ? savedChain : 84532;
const explorer = () => ({84532:"https://sepolia.basescan.org",11155111:"https://sepolia.etherscan.io",46630:"https://explorer.testnet.chain.robinhood.com"}[chainId]);
const chainHex = () => `0x${chainId.toString(16)}`;
const storageKey = () => chainId === 84532 ? "zecone:purchase" : `zecone:purchase:${chainId}`;
const updateNetworkLabel = () => { $("network").value = String(chainId); $("network-badge").textContent = `${networkNames[chainId].toUpperCase()} · TESTNET`; document.title = `${networkNames[chainId]} · Sepolia Studio`; };
const selectChain = (next) => {
  if (!Object.hasOwn(networkNames, next)) throw Error("Unsupported test network");
  chainId = next;
  localStorage.setItem("zecone:network", String(chainId));
  purchase = localStorage.getItem(storageKey());
  updateNetworkLabel();
  $("transaction").hidden = true; $("status").textContent = "Choose an available listing";
  $("detail").textContent = ""; $("error").textContent = "";
};
updateNetworkLabel();
$("network").onchange = async e => {
  if (busy) { e.target.value = String(chainId); return; }
  const next = Number(e.target.value);
  try {
    if (provider && account) await provider.request({method:"wallet_switchEthereumChain",params:[{chainId:`0x${next.toString(16)}`} ]});
    selectChain(next);
    await refresh();
  } catch(e) { message(e); $("network").value = String(chainId); }
};
let provider,
  account,
  busy = false,
  listingData = [],
  purchase = localStorage.getItem("zecone:purchase"),
  polling = false;
const message = (e) => {
  $("error").textContent = e?.message || String(e);
};
async function json(url) {
  const r = await fetch(url, { cache: "no-store" }),
    v = await r.json();
  if (!r.ok) throw Error(v.error);
  return v;
}
async function connect(p) {
  try {
    if (!p) throw Error("Install or enable an EIP-1193 wallet first.");
    provider = p;
    [account] = await p.request({ method: "eth_requestAccounts" });
    if ((await p.request({ method: "eth_chainId" })) !== chainHex())
      await p.request({method:"wallet_switchEthereumChain",params:[{chainId:chainHex()}]});
    $("account").textContent = `Connected: ${account}`;
    p.on?.("accountsChanged", (a) => {
      account = a[0];
      $("account").textContent = account
        ? `Connected: ${account}`
        : "Disconnected";
      render();
    });
    p.on?.("chainChanged", (value) => {
      try { selectChain(Number(BigInt(value))); void refresh().then(() => { if (purchase && p === zec) void poll(); }); }
      catch (e) { message(e); }
    });
    p.on?.("disconnect", () => {
      account = null;
      $("account").textContent =
        "Disconnected. Reconnect to resume saved status.";
      render();
    });
    render();
    if (purchase && p === zec) void poll();
  } catch (e) {
    account = null;
    message(e);
  }
}
$("connect").onclick = () => connect(zec);
$("standard").onclick = () => connect(window.ethereum);
function render() {
  const target = $("listings");
  target.replaceChildren();
  for (const l of listingData) {
    const card = document.createElement("article");
    card.className = "card";
    const art = document.createElement("div");
    art.className = `art ${l.tokenId === "2" ? "two" : l.tokenId === "3" ? "three" : ""}`;
    const label = document.createElement("span");
    label.textContent = `SEPOLIA STUDIO / ${l.tokenId.padStart(2, "0")}`;
    art.append(label);
    const info = document.createElement("div");
    info.className = "info";
    const title = document.createElement("h2");
    title.textContent =
      ["Quiet Orbit", "Earth Study", "Blue Interval"][Number(l.tokenId) - 1] ||
      `Study ${l.tokenId}`;
    const price = document.createElement("strong");
    price.textContent = `${Number(l.price) / 1e18} test ETH`;
    const details = document.createElement("p");
    details.textContent = `ERC-721 #${l.tokenId} · seller ${l.seller}`;
    const active = l.active && Number(l.expiry) * 1000 > Date.now();
    const actions = document.createElement("div");
    actions.className = "actions";
    for (const [text, kind] of [
      ["Pay with shielded ZEC", "zec"],
      ["Pay test ETH", "eth"],
    ]) {
      const b = document.createElement("button");
      b.textContent = active ? text : "Listing unavailable";
      b.disabled =
        !active || !account || busy || (kind === "zec" && provider !== zec);
      b.onclick = () => buy(l, kind);
      actions.append(b);
    }
    info.append(title, price, details, actions);
    card.append(art, info);
    target.append(card);
  }
}
async function refresh() {
  try {
    const r = await json(`/api/listings?chain=${chainId}`);
    listingData = r.listings;
    render();
  } catch (e) {
    $("listings").textContent = "Listings unavailable.";
    message(e);
  }
}
async function buy(l, kind) {
  busy = true;
  $("network").disabled = true;
  render();
  $("error").textContent = "";
  try {
    const tx = await json(`/api/purchase?chain=${chainId}&listing=${l.id}&recipient=${account}`);
    $("status").textContent = "Review in your wallet";
    if (kind === "zec") {
      const result = await provider.request({
        method: "zecone_payWithZec",
        params: [tx],
      });
      purchase = result.purchaseId;
      localStorage.setItem(storageKey(), purchase);
      $("detail").textContent =
        "Quote approved. Review the Zcash fee and authorize payment in the ZecOne window. Ten confirmations are required.";
      void poll();
    } else {
      const hash = await provider.request({
        method: "eth_sendTransaction",
        params: [tx],
      });
      $("status").textContent =
        "Transaction submitted — ownership not yet verified";
      $("transaction").href = `${explorer()}/tx/${hash}`;
      $("transaction").hidden = false;
      $("detail").textContent =
        "Check the transaction receipt and current NFT owner before assuming completion.";
    }
  } catch (e) {
    message(e);
    $("status").textContent = "Request did not complete";
  } finally {
    busy = false;
    $("network").disabled = false;
    render();
  }
}
async function poll() {
  if (polling || !purchase || provider !== zec || !account) return;
  polling = true;
  try {
    const r = await provider.request({
      method: "zecone_getPurchaseStatus",
      params: [purchase],
    });
    $("status").textContent = r.status;
    if (r.baseTx) {
      $("transaction").href = `${r.explorer ?? explorer()}/tx/${r.baseTx}`;
      $("transaction").hidden = false;
    }
    if (r.ownerVerified) {
      $("detail").textContent =
        `Ownership verified: NFT #${r.tokenId} belongs to ${r.recipient}.`;
      await refresh();
    } else if (r.manualRecovery)
      $("detail").textContent =
        "Open ZecOne Purchases for the recovery record. Do not pay again.";
  } catch (e) {
    message(e);
  } finally {
    polling = false;
  }
}
void refresh();
setInterval(() => void poll(), 7000);
