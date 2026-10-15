const chains = {
  "0x14a34": "Base Sepolia",
  "0xaa36a7": "Ethereum Sepolia",
  "0xb626": "Robinhood Testnet",
};
document.querySelector("a").addEventListener("click", async (e) => {
  e.preventDefault();
  await chrome.runtime.sendMessage({ kind: "open-wallet" });
});
async function refresh() {
  try {
    const status = await chrome.runtime.sendMessage({ kind: "status" });
    const root = document.getElementById("connections");
    root.replaceChildren();
    if (!status.connections.length)
      root.textContent =
        "Disconnected. Open a compatible HTTPS dApp and select ZecOne Testnet.";
    for (const c of status.connections) {
      const div = document.createElement("section");
      div.className = "site";
      for (const text of [
        c.origin,
        c.account || "Account access not approved",
        chains[c.chainId],
        `${c.pending} pending approval request(s)`,
      ]) {
        const p = document.createElement("p");
        p.className = "mono";
        p.textContent = text;
        div.append(p);
      }
      const button = document.createElement("button");
      button.textContent = "Disconnect transport";
      button.onclick = async () => {
        await chrome.runtime.sendMessage({ kind: "disconnect", id: c.id });
        await refresh();
      };
      div.append(button);
      root.append(div);
    }
    document.getElementById("logs").textContent = JSON.stringify(
      status.logs,
      null,
      2,
    );
  } catch {
    document.getElementById("error").textContent =
      "Extension unavailable. Reload it and reconnect explicitly.";
  }
}
refresh();
setInterval(refresh, 2000);
