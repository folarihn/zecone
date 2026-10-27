# Demo-only launch architecture

The public launch is a simulated product demonstration. It does not accept a
payable Zcash address and cannot authorize a Base payout or Zcash broadcast.

The website and Access Pass frontend are prepared for separate Vercel projects.
The Payment API and Access Pass merchant backend are prepared for the isolated
Contabo Compose stack in `deploy/demo`. Only those demo services sit behind
Caddy. Persistent storage is limited to a demo SQLite database and Access Pass
merchant state. The real wallet, mainnet watcher, relayer, submitter, operator
tokens, signing keys, and keystores remain local and are not deployment inputs.

`ZECONE_PAYMENTS_MODE=demo` maps the checkout receiver to
`demo:no-payable-address`. Production startup additionally requires a fresh
32-character-or-longer demo secret, HTTPS public URL, disabled HTTP webhooks,
and no operator token. The executable server still refuses `live` mode.

Access Pass keeps entitlement verification server-side. Its Vercel function is
only a same-origin `/api/*` transport proxy; API keys and webhook verification
remain in the persistent VPS backend. The webhook endpoint is not proxied
through Vercel.

No deployment URL is recorded until the operator has approved publication and
the returned URL, HTTPS health response, and end-to-end demo checkout have been
verified. See `deploy/demo/README.md` for environment, launch, backup, and
rollback steps.
