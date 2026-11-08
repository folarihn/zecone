// Telegram delivery for operator supervisor alerts.
//
// The supervisor raises some alerts every cycle while a condition lasts (for
// example SCAN_STALE), so this sends a message when a condition starts, a
// reminder at most every `remindSeconds` while it lasts, and a "resolved"
// message once a cycle no longer raises it. Delivery is best effort: a failed
// send is reported to the caller's logger and never affects the cycle. The bot
// token is read from a protected file and is never logged or sent anywhere but
// api.telegram.org.
import type { SupervisorAlert } from "./operator-supervisor.ts";

export const TELEGRAM_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
export const TELEGRAM_CHAT_ID = /^-?\d{1,20}$/;

export function validateTelegramToken(text: string): string {
  const token = text.trim();
  if (!TELEGRAM_TOKEN.test(token)) throw Error("TELEGRAM_TOKEN_INVALID");
  return token;
}

export function validateTelegramChatId(value: unknown): string {
  const id = String(value ?? "").trim();
  if (!TELEGRAM_CHAT_ID.test(id)) throw Error("TELEGRAM_CHAT_ID_INVALID");
  return id;
}

/** One condition per key, so a lasting condition is reported once, not per cycle. */
export function alertKey(a: SupervisorAlert): string {
  switch (a.alert) {
    case "STAGE_FAILING":
      return `STAGE_FAILING:${a.stage}`;
    case "LOCK_RECOVERY_REFUSED":
    case "LOCK_RECOVERED":
      return `${a.alert}:${a.lock}`;
    case "NETWORK_UPGRADE_UNSUPPORTED":
      return `${a.alert}:${a.branchId}`;
    default:
      return a.alert;
  }
}

/** Events that happen once rather than lasting; they never get a "resolved". */
const ONE_SHOT = new Set(["LOCK_RECOVERED"]);

export function describeAlert(a: SupervisorAlert): string {
  switch (a.alert) {
    case "HEARTBEAT_STALE":
      return `Heartbeat stale (${a.ageSeconds ?? "none"} s, limit ${a.limitSeconds} s). Real checkouts are paused.`;
    case "SCAN_STALE":
      return `Wallet scan stale (${a.ageSeconds ?? "none"} s, limit ${a.limitSeconds} s).`;
    case "STAGE_FAILING":
      return `Stage ${a.stage} failing ${a.consecutive} cycles in a row (${a.code ?? "no code"}).`;
    case "TUNNEL_DOWN":
      return `SSH tunnel down; restarting in ${Math.round(a.restartInMs / 1000)} s.`;
    case "LOCK_RECOVERY_REFUSED":
      return `Watch lock recovery refused (${a.reason}). The cycle is stopped until resolved.`;
    case "LOCK_RECOVERED":
      return `Abandoned watch lock recovered (evidence kept).`;
    case "NETWORK_UPGRADE_UNSUPPORTED":
      return a.blocksUntilActivation > 0
        ? `Zcash upgrade ${a.name} activates in ${a.blocksUntilActivation} blocks at ${a.activationHeight}; this build does not support it (${a.reason}). Upgrade the Zcash libraries before activation.`
        : `Zcash upgrade ${a.name} is active since ${a.activationHeight} and this build does not support it (${a.reason}). The watcher will fail.`;
  }
}

export interface TelegramSender {
  (text: string): Promise<void>;
}

export function telegramSender(
  token: string,
  chatId: string,
  fetchImpl: typeof fetch = fetch,
): TelegramSender {
  return async (text) => {
    const response = await fetchImpl(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) throw Error(`TELEGRAM_HTTP_${response.status}`);
  };
}

export class TelegramAlerts {
  private active = new Map<string, number>();

  constructor(
    private readonly send: TelegramSender,
    private readonly options: {
      now(): number;
      log(event: Record<string, unknown>): void;
      remindSeconds?: number;
      label?: string;
    },
  ) {}

  private async deliver(text: string) {
    try {
      await this.send(`${this.options.label ?? "ZecOne"}: ${text}`);
    } catch (error) {
      this.options.log({
        event: "TELEGRAM_SEND_FAILED",
        code:
          error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message)
            ? error.message
            : "TELEGRAM_SEND_FAILED",
      });
    }
  }

  async notice(text: string) {
    await this.deliver(text);
  }

  /** Call once per cycle with every alert that cycle raised. */
  async onCycle(alerts: SupervisorAlert[]) {
    const now = this.options.now();
    const remind = this.options.remindSeconds ?? 6 * 3600;
    const seen = new Set<string>();
    for (const a of alerts) {
      const key = alertKey(a);
      if (seen.has(key)) continue;
      seen.add(key);
      const since = this.active.get(key);
      if (ONE_SHOT.has(a.alert)) {
        await this.deliver(describeAlert(a));
        continue;
      }
      if (since === undefined) {
        this.active.set(key, now);
        await this.deliver(`ALERT ${describeAlert(a)}`);
      } else if (now - since >= remind) {
        this.active.set(key, now);
        await this.deliver(`STILL ${describeAlert(a)}`);
      }
    }
    for (const key of [...this.active.keys()])
      if (!seen.has(key)) {
        this.active.delete(key);
        await this.deliver(`RESOLVED ${key.split(":")[0]}`);
      }
  }
}
