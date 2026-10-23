"use client";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Browser-side call to the Brio API (same origin via rewrites). Throws ApiError with the API's message. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const issues = (data?.issues as { message: string }[] | undefined)?.map((i) => i.message).join(", ");
    throw new ApiError(res.status, issues || data?.message || `request failed (${res.status})`);
  }
  return data as T;
}
