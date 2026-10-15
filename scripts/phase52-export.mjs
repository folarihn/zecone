// Review-only portable manifest. No key access, signing, networking or broadcasting.
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { exclusiveJson } from "../services/execution/io.ts";
import { validatePhase52Profile } from "../services/validation/phase52-profile.ts";
const p = validatePhase52Profile(
    JSON.parse(readFileSync(".state/phase52-profile.json", "utf8")),
  ),
  directory = resolve(".state/phase52", p.id, "transfer");
const names = [
  "unsigned-refund.pczt",
  "unsigned-refund.json",
  "unsigned-refund-request.json",
];
const files = names.map((name) => ({
  name,
  sha256: createHash("sha256")
    .update(readFileSync(join(directory, name)))
    .digest("hex"),
}));
const manifest = {
  version: 1,
  format: "zecone-phase52-review-only",
  profileId: p.id,
  files,
  authorizationComplete: false,
  signingEnabled: false,
  broadcastEnabled: false,
  separateDeviceValidated: false,
  requires:
    "Fresh independent chain/witness verification, user/operator authorization and validated signer device before enabling live signing. This package cannot be passed to the synthetic-only signing CLI as a live request.",
};
const path = join(directory, "portable-manifest.json");
if (existsSync(path)) {
  if (
    JSON.stringify(JSON.parse(readFileSync(path, "utf8"))) !==
    JSON.stringify(manifest)
  )
    throw Error("portable_manifest_conflict");
} else exclusiveJson(path, manifest);
console.log(
  JSON.stringify({
    directory,
    manifestFile: path,
    files: files.map((f) => f.name),
    signingEnabled: false,
    broadcastEnabled: false,
  }),
);
