import "server-only";
import { cookies, headers } from "next/headers";

const apiUrl = () => process.env.API_URL ?? "http://localhost:4000";

/** Calls the Brio API from a server component, forwarding the caller's cookies and address. */
export async function serverApi<T>(path: string): Promise<{ status: number; data: T | null }> {
  const jar = await cookies();
  // The person's address, so the API's per-address limits are theirs, not the web server's (shared by everyone).
  const forwarded = (await headers()).get("x-forwarded-for");
  const res = await fetch(`${apiUrl()}${path}`, {
    headers: {
      cookie: jar.toString(),
      origin: process.env.APP_URL ?? "http://localhost:3000",
      ...(forwarded ? { "x-forwarded-for": forwarded } : {}),
    },
    cache: "no-store",
  });
  const data = res.headers.get("content-type")?.includes("application/json")
    ? ((await res.json()) as T)
    : null;
  return { status: res.status, data };
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const { data } = await serverApi<{ user: SessionUser } | null>("/api/auth/get-session");
  return data?.user ?? null;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "admin" | "member" | "viewer";
  active: boolean;
}

export async function getWorkspaces(): Promise<{
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string | null;
}> {
  const { data } = await serverApi<{ workspaces: WorkspaceSummary[]; activeWorkspaceId: string | null }>(
    "/v1/workspaces",
  );
  return data ?? { workspaces: [], activeWorkspaceId: null };
}
