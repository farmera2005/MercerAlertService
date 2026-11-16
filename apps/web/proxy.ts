import { NextResponse, type NextRequest } from 'next/server';

/**
 * Forwards the requested path to server components (layouts can't see the URL) so a sign-in
 * redirect returns the admin to the page they asked for.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set('x-mas-path', request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/((?!_next/|api/|favicon.ico).*)'],
};
