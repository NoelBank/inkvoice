// Lightweight fetch helper for plugin API calls. The OSS `api` object is a
// closed const we can't extend from the overlay, so plugins talk to their own
// /api/v1/plugins/* endpoints through this. Mirrors the OSS client's auth: an
// in-memory Bearer token (when present) plus credentials for cookie sessions.

import { getAuthToken } from "@/api/client";

const BASE = "/api/v1";

export async function pluginFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(options.headers as Record<string, string>) };
  const token = getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (!(options.body instanceof FormData)) headers["Content-Type"] = "application/json";

  const res = await fetch(`${BASE}${path}`, { ...options, headers, credentials: "include" });
  const data = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    error?: string;
    data?: unknown;
  };
  if (!res.ok || data?.success === false) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data as T;
}
