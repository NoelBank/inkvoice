// Outbound JSON fetch for URLs an untrusted party can configure. validateUrl
// alone is not enough for those: a bare fetch() follows redirects internally,
// so a public URL that answers 302 -> http://169.254.169.254/ would sail past
// a check performed only on the URL that was typed. Redirects are therefore
// followed by hand here, re-validating every hop, and the body is read against
// a byte budget so a hostile endpoint cannot stream unbounded JSON into memory.
//
// Errors carry a coarse machine code as well as a message. Callers that show
// anything to a non-operator must surface only the code: the exact message
// distinguishes "connection refused" from "HTTP 403" from "not JSON", which is
// a usable oracle for mapping an internal network from the outside.

import { validateUrl } from "./ssrf-protection";

export type SafeFetchErrorCode =
  | "blocked"
  | "unreachable"
  | "http_error"
  | "too_large"
  | "invalid_json";

export class SafeFetchError extends Error {
  constructor(
    public readonly code: SafeFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
}

export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export async function safeFetchJson(url: string, opts: SafeFetchOptions = {}): Promise<unknown> {
  const {
    timeoutMs = 5_000,
    maxBytes = DEFAULT_MAX_BYTES,
    maxRedirects = 3,
    method = "GET",
    body,
    headers = {},
  } = opts;

  let current = url;
  for (let hop = 0; ; hop++) {
    try {
      await validateUrl(current, { allowUnresolvable: false });
    } catch (err) {
      throw new SafeFetchError("blocked", (err as Error).message);
    }

    let res: Response;
    try {
      res = await fetch(current, {
        method,
        body,
        // Manual, so the hop below is validated before it is followed.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: "application/json", ...headers },
      });
    } catch (err) {
      throw new SafeFetchError("unreachable", (err as Error).message || "fetch failed");
    }

    if (res.status >= 300 && res.status < 400) {
      // Only GET is redirect-followed: 301/302/303 rewrite a POST to GET, which
      // would silently turn a vote into a read against an attacker's endpoint.
      if (method !== "GET") throw new SafeFetchError("http_error", `HTTP ${res.status}`);
      if (hop >= maxRedirects) throw new SafeFetchError("blocked", "too many redirects");
      const location = res.headers.get("location");
      if (!location) throw new SafeFetchError("http_error", `HTTP ${res.status} without Location`);
      try {
        current = new URL(location, current).toString();
      } catch {
        throw new SafeFetchError("blocked", "malformed redirect target");
      }
      continue;
    }

    if (!res.ok) throw new SafeFetchError("http_error", `HTTP ${res.status}`);

    const text = await readCapped(res, maxBytes);
    try {
      return JSON.parse(text);
    } catch {
      throw new SafeFetchError("invalid_json", "response was not JSON");
    }
  }
}

/** Read the body, refusing to buffer more than maxBytes. Checks the declared
 *  length first as a cheap rejection, then enforces the real budget while
 *  streaming, because Content-Length can lie or be absent. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new SafeFetchError("too_large", `declared ${declared} bytes, limit ${maxBytes}`);
  }

  const reader = res.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new SafeFetchError("too_large", `exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}
