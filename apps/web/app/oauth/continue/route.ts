// Resumes an MCP client's OAuth authorization after the person signed in: back to the authorize endpoint with the
// original request, which now finds a session and goes on to consent.
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export function GET(req: NextRequest) {
  const q = new URLSearchParams(req.nextUrl.searchParams);
  q.delete("next");
  return NextResponse.redirect(new URL(`/api/auth/oauth2/authorize?${q}`, req.nextUrl.origin));
}
