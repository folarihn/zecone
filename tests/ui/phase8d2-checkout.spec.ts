// Presentation-only fixtures. All APIs intercepted; no live wallet process.
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { encodeFunctionData } from "viem";
import {
  evmIntent,
  intentAbi,
} from "../../services/wallet/transaction-intents.ts";
for (const expired of [false, true])
  test(`checkout rehearsal ${expired ? "rejects expired review" : "requires distinct quote and checkout gestures"}`, async ({
    page,
    context,
  }) => {
    const origin = "http://127.0.0.1:3211",
      id = randomUUID(),
      channel = randomUUID(),
      account = "0x1111111111111111111111111111111111111111",
      target = "0x2222222222222222222222222222222222222222";
    const params = [
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
        session: "fixture",
        chainId: 84532,
        permitted: true,
        expires: Date.now() + 600000,
      },
      id,
      params,
      [],
    );
    const quoteId = randomUUID(),
      digest = "f".repeat(64);
    let consent = false,
      quotes = 0,
      reviews = 0,
      creates = 0;
    const forbidden: string[] = [];
    await context.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      let data: unknown;
      if (path === "/api/session") data = { connected: true, csrf: "fixture" };
      else if (path === "/api/dapps/list")
        data = {
          connections: [{ origin }],
          networks: [{ origin, chainId: 84532 }],
        };
      else if (path === "/api/dapps/request" || path === "/api/dapps/status")
        data = consent
          ? { done: true, error: { code: 4001, message: "Preview only" } }
          : {
              done: false,
              id,
              origin,
              method: "eth_sendTransaction",
              state: "pending",
              reviewHash: "preview",
              review: { intent, chainId: 84532, account },
            };
      else if (path === "/api/dapps/approve") {
        consent = true;
        data = {
          done: true,
          previewConsentRecorded: true,
          error: { code: 4001, message: "Preview only" },
        };
      } else if (path === "/api/dapps/intent-quote") {
        quotes++;
        expect(route.request().postDataJSON()).toEqual({ id });
        data = {
          mode: "dry-run",
          executionAuthorized: false,
          id: quoteId,
          digest,
          expires: Date.now() + 60000,
          terms: {
            network: "eip155:84532",
            nft: target,
            tokenId: "7",
            recipient: account,
            priceWei: "100000000000000",
            zatoshis: "1000000",
            gasBudgetWei: "100000000000000",
            estimatedFeeWei: "41200010000000",
            slippageBps: 0,
          },
        };
      } else if (
        path === "/api/dapps/intent-quote-review" ||
        path === "/api/dapps/intent-checkout-preview"
      ) {
        expect(route.request().postDataJSON()).toEqual({
          id,
          quoteId,
          digest,
          approved: true,
        });
        if (path.endsWith("quote-review")) {
          reviews++;
          data = {
            reviewed: true,
            checkoutCreated: false,
            executionAuthorized: false,
          };
        } else {
          creates++;
          data = {
            mode: "dry-run",
            financialCheckoutCreated: false,
            paymentRequestCreated: false,
            executionAuthorized: false,
          };
        }
      } else {
        forbidden.push(path);
        data = {};
      }
      await route.fulfill({ json: data });
    });
    await context.route(`${origin}/checkout-fixture`, (r) =>
      r.fulfill({
        contentType: "text/html",
        body: "<h1>Synthetic dApp</h1><script>window.responses=[];addEventListener('message',e=>{if(e.data?.kind==='response')responses.push(e.data)})</script>",
      }),
    );
    await page.goto("/checkout-fixture");
    const wait = page.waitForEvent("popup");
    await page.evaluate((channel) => {
      (window as any).popup = window.open(`/connect#${channel}`);
    }, channel);
    const popup = await wait;
    await expect(
      popup.getByText("Ready. Return to the application to request an action."),
    ).toBeVisible();
    await page.evaluate(
      ({ id, channel, params }) => {
        (window as any).popup.postMessage(
          {
            protocol: "zecone:2",
            channel,
            kind: "request",
            id,
            method: "eth_sendTransaction",
            params,
          },
          location.origin,
        );
      },
      { id, channel, params },
    );
    await popup.getByRole("button", { name: "Record preview consent" }).click();
    await expect(
      popup.getByRole("heading", { name: "ZEC checkout rehearsal" }),
    ).toBeVisible();
    expect(quotes).toBe(0);
    expect(creates).toBe(0);
    await popup.clock.install({ time: new Date() });
    await popup.getByRole("button", { name: "Get checkout quote" }).click();
    await expect(popup.getByText("1000000 zatoshis (TAZ)")).toBeVisible();
    expect(reviews).toBe(0);
    expect(creates).toBe(0);
    await popup.getByRole("button", { name: "Review quote only" }).click();
    await expect(
      popup.getByRole("button", { name: "Authorize dry-run checkout" }),
    ).toBeVisible();
    expect(creates).toBe(0);
    if (expired) await popup.clock.fastForward(120001);
    await popup
      .getByRole("button", { name: "Authorize dry-run checkout" })
      .click();
    if (expired) {
      await expect(
        popup
          .getByRole("region", { name: "ZEC checkout rehearsal" })
          .getByRole("alert"),
      ).toContainText("Quote expired");
      expect(creates).toBe(0);
      expect(quotes).toBe(1);
    } else {
      await expect(popup.getByRole("status")).toContainText(
        "No financial checkout or payment request exists",
      );
      expect(creates).toBe(1);
    }
    expect(forbidden).toEqual([]);
    const responses = await page.evaluate(() =>
      JSON.stringify((window as any).responses),
    );
    expect(responses).not.toContain(quoteId);
    expect(responses).not.toContain("zatoshis");
    await popup.close();
  });
