// Browser presentation/transport fixtures only. Every API call is intercepted.
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { encodeFunctionData } from "viem";
import {
  evmIntent,
  intentAbi,
} from "../../services/wallet/transaction-intents.ts";

for (const approved of [false, true])
  test(`intent review ${approved ? "consent" : "cancellation"} discloses execution boundary and sends only exact review consent`, async ({
    page,
    context,
  }) => {
    const origin = "http://127.0.0.1:3211",
      id = randomUUID(),
      channel = randomUUID();
    const account = "0x1111111111111111111111111111111111111111",
      target = "0x2222222222222222222222222222222222222222";
    const p = [
      {
        from: account,
        to: target,
        value: "0x1",
        data: encodeFunctionData({
          abi: intentAbi,
          functionName: "buy",
          args: [1n, account],
        }),
      },
    ];
    const intent = evmIntent(
      {
        origin,
        channel,
        account,
        session: "synthetic",
        chainId: 84532,
        permitted: true,
        expires: Date.now() + 600000,
      },
      id,
      p,
      [],
    );
    const reviewHash = "fixture-exact-review";
    const review = {
      done: false,
      id,
      origin,
      method: "eth_sendTransaction",
      state: "pending",
      expires: intent.expires,
      reviewHash,
      review: { intent, account, chainId: 84532, networkName: "Base Sepolia" },
    };
    const decisions: unknown[] = [],
      unexpected: string[] = [];
    let terminal = false;
    await context.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown;
      if (path === "/api/session")
        body = { connected: true, csrf: "fixture-csrf" };
      else if (path === "/api/dapps/list")
        body = {
          connections: [{ origin }],
          networks: [{ origin, chainId: 84532 }],
        };
      else if (path === "/api/dapps/request" || path === "/api/dapps/status")
        body = terminal
          ? { done: true, error: { code: 4001, message: "No execution" } }
          : review;
      else if (path === "/api/dapps/approve") {
        decisions.push(route.request().postDataJSON());
        terminal = true;
        body = { done: true, error: { code: 4001, message: "No execution" } };
      } else {
        unexpected.push(path);
        body = {};
      }
      await route.fulfill({ json: body });
    });
    await context.route(`${origin}/intent-fixture`, (r) =>
      r.fulfill({
        contentType: "text/html",
        body: "<h1>Synthetic origin</h1>",
      }),
    );
    await page.goto("/intent-fixture");
    const popupWait = page.waitForEvent("popup");
    await page.evaluate((channel) => {
      (window as any).preview = window.open(`/connect#${channel}`);
    }, channel);
    const popup = await popupWait;
    await expect(
      popup.getByText("Ready. Return to the application to request an action."),
    ).toBeVisible();
    await page.evaluate(
      ({ id, channel, p }) => {
        (window as any).preview.postMessage(
          {
            protocol: "zecone:2",
            channel,
            kind: "request",
            id,
            method: "eth_sendTransaction",
            params: p,
          },
          location.origin,
        );
      },
      { id, channel, p },
    );
    await expect(
      popup.getByText("Disabled — preview consent only", { exact: true }),
    ).toBeVisible();
    await expect(
      popup.getByText("No gas is sponsored by this preview.", { exact: false }),
    ).toBeVisible();
    await expect(
      popup.getByRole("definition").filter({
        hasText: "Destination transactions and recipients are public.",
      }),
    ).toBeVisible();
    await popup
      .getByRole("button", {
        name: approved ? "Record preview consent" : "Reject request",
      })
      .click();
    await expect.poll(() => decisions.length).toBe(1);
    expect(decisions).toEqual([{ id, reviewHash, approved }]);
    expect(unexpected).toEqual([]);
    await popup.close();
  });
