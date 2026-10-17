import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
export const ORIGIN = "http://127.0.0.1:3210";
export const randomToken = () => randomBytes(32).toString("hex");
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export type Session = {
  id: string;
  csrf: string;
  expires: number;
  connected: number;
};
export function requireLocal(
  headers: Record<string, string | undefined>,
  mutation: boolean,
) {
  if (headers.host !== "127.0.0.1:3210")
    throw new ApiError(403, "Open ZecOne on its local address.");
  if (headers.origin && headers.origin !== ORIGIN)
    throw new ApiError(403, "Origin not allowed.");
  if (mutation && headers.origin !== ORIGIN)
    throw new ApiError(403, "A local browser origin is required.");
  if (
    headers["sec-fetch-site"] &&
    !["same-origin", "none"].includes(headers["sec-fetch-site"]!)
  )
    throw new ApiError(403, "Cross-site requests are not allowed.");
  if (mutation && headers["content-type"]?.split(";")[0] !== "application/json")
    throw new ApiError(415, "JSON is required.");
}
export class Sessions {
  constructor(
    readonly db: DatabaseSync,
    readonly now = () => Date.now(),
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires INTEGER NOT NULL,connected INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS pairing(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);",
    );
  }
  private prune() {
    // Only ephemeral authentication rows. Never touch checkout ownership,
    // payment evidence, execution claims or financial audit records.
    this.db.prepare("DELETE FROM sessions WHERE expires<=?").run(this.now());
    this.db.prepare("DELETE FROM pairing WHERE expires<=?").run(this.now());
  }
  issuePairing() {
    this.prune();
    const token = randomToken();
    this.db.exec("DELETE FROM pairing");
    this.db
      .prepare("INSERT INTO pairing VALUES(?,?)")
      .run(hash(token), this.now() + 600000);
    return token;
  }
  pair(token: unknown) {
    this.prune();
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
      throw new ApiError(401, "Pairing link is invalid or expired.");
    const consumed = this.db
      .prepare("DELETE FROM pairing WHERE hash=? AND expires>? RETURNING hash")
      .get(hash(token), this.now());
    if (!consumed)
      throw new ApiError(401, "Pairing link is invalid or expired.");
    const cookie = randomToken(),
      id = hash(cookie),
      csrf = randomToken(),
      expires = this.now() + 60 * 60 * 1000;
    this.db
      .prepare("INSERT INTO sessions VALUES(?,?,?,0)")
      .run(id, csrf, expires);
    return { cookie, session: { id, csrf, expires, connected: 0 } };
  }
  get(cookieHeader: string | undefined): Session {
    this.prune();
    const cookie = cookieHeader
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("zecone_session="))
      ?.slice(15);
    if (!cookie || !/^[a-f0-9]{64}$/.test(cookie))
      throw new ApiError(401, "Unlock your local wallet to continue.");
    const s = this.db
      .prepare("SELECT * FROM sessions WHERE id=? AND expires>?")
      .get(hash(cookie), this.now()) as Session | undefined;
    if (!s)
      throw new ApiError(
        401,
        "Your session expired. Reopen the local launcher.",
      );
    return s;
  }
  csrf(s: Session, value: string | undefined) {
    if (
      !value ||
      Buffer.byteLength(value) !== Buffer.byteLength(s.csrf) ||
      !timingSafeEqual(Buffer.from(value), Buffer.from(s.csrf))
    )
      throw new ApiError(403, "Request verification failed.");
  }
  disconnect(s: Session) {
    this.db.prepare("DELETE FROM sessions WHERE id=?").run(s.id);
  }
}
