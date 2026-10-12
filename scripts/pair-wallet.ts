// Called by the local launcher, never by an unauthenticated HTTP route.
import { writeFileSync } from "node:fs";
import { AppState } from "../services/wallet/state.ts";
import { Sessions } from "../services/wallet/security.ts";
const state = new AppState();
writeFileSync(
  ".secrets/browser-pairing.json",
  JSON.stringify({
    token: new Sessions(state.db).issuePairing(),
    expires: Date.now() + 600000,
  }),
  { mode: 0o600 },
);
state.close();
