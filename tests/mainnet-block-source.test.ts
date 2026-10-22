import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRawBlockProviders,
  fetchCorroboratedRawBlock,
  type RawBlockProvider,
} from "../services/settlement/mainnet-block-source.ts";

const providers: RawBlockProvider[] = [
  {
    endpoint: "https://rpc-a.net",
    operator: "operator-a",
    protocol: "zcash-json-rpc",
  },
  {
    endpoint: "https://blocks-b.org/raw",
    operator: "operator-b",
    protocol: "blockchair-rest",
  },
];
const raw = "00".repeat(109);

function responses(second = raw) {
  let call = 0;
  return (async () => {
    call += 1;
    return new Response(
      JSON.stringify(
        call === 1
          ? { result: raw, error: null }
          : { data: { ["a".repeat(64)]: { raw_block: second } } },
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

test("raw block providers must be independent HTTPS operators", () => {
  assert.doesNotThrow(() => assertRawBlockProviders(providers));
  assert.throws(
    () => assertRawBlockProviders([providers[0], providers[0]]),
    /hosts_must_be_distinct/,
  );
  assert.throws(
    () =>
      assertRawBlockProviders([
        providers[0],
        { ...providers[1], operator: providers[0].operator },
      ]),
    /operators_must_be_distinct/,
  );
  assert.throws(
    () =>
      assertRawBlockProviders([
        { ...providers[0], endpoint: "https://rpc-a.net/?api-key=secret" },
        providers[1],
      ]),
    /provider_invalid/,
  );
});

test("corroborated raw block requires exact bytes", async () => {
  const result = await fetchCorroboratedRawBlock(
    providers,
    "a".repeat(64),
    responses(),
  );
  assert.equal(result.exactByteAgreement, true);
  assert.equal(result.bytes.toString("hex"), raw);
  assert.deepEqual(result.operators, ["operator-a", "operator-b"]);
});

test("raw block disagreement fails closed", async () => {
  await assert.rejects(
    fetchCorroboratedRawBlock(
      providers,
      "a".repeat(64),
      responses(`${raw.slice(0, -2)}01`),
    ),
    /provider_disagreement/,
  );
});

test("raw block requests reject redirects and oversized responses", async () => {
  const redirects: Array<string | undefined> = [];
  const redirecting = (async (_input: unknown, init?: RequestInit) => {
    redirects.push(init?.redirect);
    const body =
      init?.method === "POST"
        ? { result: raw, error: null }
        : { data: { ["a".repeat(64)]: { raw_block: raw } } };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const result = await fetchCorroboratedRawBlock(
    providers,
    "a".repeat(64),
    redirecting,
  );
  assert.equal(result.exactByteAgreement, true);
  assert.equal(redirects.length, 2);
  assert.ok(redirects.every((value) => value === "error"));

  const oversized = (async () =>
    new Response("{}", {
      status: 200,
      headers: { "content-length": String(64 * 1024 * 1024) },
    })) as typeof fetch;
  await assert.rejects(
    fetchCorroboratedRawBlock(providers, "a".repeat(64), oversized),
    /response_invalid/,
  );
});

test("optional provider authentication is read locally and never returned", async () => {
  const secret = "disposable-stage4b-api-key";
  process.env.ZECONE_TEST_RAW_BLOCK_KEY = secret;
  const authenticated: RawBlockProvider[] = [
    {
      ...providers[0],
      authHeader: "x-api-key",
      authEnv: "ZECONE_TEST_RAW_BLOCK_KEY",
    },
    providers[1],
  ];
  const observedHeaders: Array<Record<string, string>> = [];
  let call = 0;
  const fetcher = (async (_input: unknown, init?: RequestInit) => {
    observedHeaders.push(init?.headers as Record<string, string>);
    call += 1;
    return new Response(
      JSON.stringify(
        call === 1
          ? { result: raw, error: null }
          : { data: { ["a".repeat(64)]: { raw_block: raw } } },
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const result = await fetchCorroboratedRawBlock(
      authenticated,
      "a".repeat(64),
      fetcher,
    );
    assert.equal(observedHeaders[0]["x-api-key"], secret);
    assert.equal(JSON.stringify(result).includes(secret), false);
  } finally {
    delete process.env.ZECONE_TEST_RAW_BLOCK_KEY;
  }
});
