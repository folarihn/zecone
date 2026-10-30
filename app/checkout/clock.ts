"use client";
import { useEffect, useState } from "react";
export function useClock() {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
export function reviewExpired(
  terms: { expiry: number; fee?: { expires?: number } },
  now: number,
) {
  return (
    now > 0 &&
    (terms.expiry * 1000 <= now ||
      (terms.fee?.expires !== undefined && terms.fee.expires <= now))
  );
}
