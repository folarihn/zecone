// No wallet, order or payment identifiers. A display handle is not authority.
export const SELECTION_KEY = "zecone.checkout.session-selection";
export function restoreSelection(
  raw: string | null,
  scope: string,
  expires: number,
  keys: string[],
  now = Date.now(),
) {
  try {
    const r = JSON.parse(raw ?? "null");
    return r &&
      r.scope === scope &&
      r.expires === expires &&
      expires > now &&
      keys.includes(r.key)
      ? (r.key as string)
      : "";
  } catch {
    return "";
  }
}
