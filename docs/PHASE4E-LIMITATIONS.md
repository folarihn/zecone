# Phase 4E limitations

- Actual OpenSea discovery, approval, login signing, account display, logout and revocation are demonstrated with Chromium 156.0.8078.4 / extension 0.2.0. This is not certification of every Chrome/Edge version, mobile browser or a Web Store release.
- Production injection is limited to the two exact OpenSea HTTPS origins, top frame. Independent fixtures alter only their private test copy's allowlist. Other unrelated sites need separately reviewed scope; the cooperating-dApp SDK remains available.
- OpenSea tried unsupported `wallet_requestPermissions` and successfully fell back to `eth_requestAccounts`. EIP-2255 convenience methods are not claimed. Future site changes could remove the fallback.
- Login succeeded with Base Sepolia. OpenSea requested no network switch, typed order or transaction during that flow. Local tests verify those policies; mainnet asset interoperability is neither demonstrated nor enabled.
- The local wallet must run and be paired/ownership-verified in the same browser profile. An opener-preserving popup is required. Popup blocking, COOP changes, local network policy, extension restrictions, expired sessions or signer outage can break the flow. Record failures; never weaken origin protections or evade site challenges.
- The extension is not a keystore. Existing plaintext test keys stay with the trusted local signer. No production custody, hardware wallet, key migration, native host or encrypted vault was added.
- A compromised page can lie to itself, including fabricating page-visible provider results; it cannot thereby obtain a valid user signature or local approval. Wallet-origin XSS, hostile extensions and same-user malware remain risks.
- Origin grants, browser transport and OpenSea web sessions are distinct. Closing a transport alone does not revoke grants or log out. Testing explicitly used OpenSea Log Out, verified backend revocation and closed the dedicated browser. The authorized public test profile remains created.
- Method logs are bounded/volatile; restart clears them. Historical evidence is dated, not a guarantee of future behavior. No complete anonymity is claimed.
- General SIWE semantic enforcement, WalletConnect, production exchange/bridge, mainnet asset execution, automatic refunds and Phase 5 remain out of scope. Earlier recovery procedures are unchanged.
