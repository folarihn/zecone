import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const base = readFileSync("deploy/demo/compose.yaml", "utf8");
const nginx = readFileSync("deploy/demo/compose.nginx.yaml", "utf8");
const site = readFileSync("deploy/demo/nginx/zecone-demo.conf", "utf8");

test("shared Contabo override keeps demo services loopback-only behind existing Nginx", () => {
  assert.match(nginx, /network_mode:\s*host/g);
  assert.match(nginx, /ZECONE_PAYMENTS_HOST:\s*127\.0\.0\.1/);
  assert.match(nginx, /ACCESS_PASS_HOST:\s*127\.0\.0\.1/);
  assert.match(nginx, /ZECONE_BASE_URL:\s*http:\/\/127\.0\.0\.1:4321/);
  assert.match(nginx, /profiles:\s*\[standalone-caddy\]/);
  assert.doesNotMatch(nginx, /ports:/);

  assert.match(site, /server_name api\.zecone\.xyz/);
  assert.match(site, /proxy_pass http:\/\/127\.0\.0\.1:4321/);
  assert.match(site, /server_name access-api\.zecone\.xyz/);
  assert.match(site, /proxy_pass http:\/\/127\.0\.0\.1:4333/);
  assert.doesNotMatch(site, /proxy_pass\s+https?:\/\/(?!127\.0\.0\.1)/);
});

test("demo base remains non-financial and contains no wallet or relayer mount", () => {
  assert.match(base, /ZECONE_PAYMENTS_MODE:\s*demo/);
  assert.match(base, /ZECONE_OPERATOR_TOKEN:\s*""/);
  assert.match(base, /ZECONE_DEMO_OBSERVER:\s*"1"/);
  assert.doesNotMatch(
    base,
    /keystore|private[_-]?key|relayer[_-]?key|wallet\.db/i,
  );
});
