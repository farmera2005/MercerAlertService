import 'server-only';
import NextAuth, { type NextAuthConfig } from 'next-auth';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';
import { evaluateEntraSignIn, type AppConfig, type EntraClaims } from '@mercer/core';
import { findUserByOid, recordDeniedSignIn, upsertEntraUser } from '@mercer/db';
import { requestMeta } from './request';
import { server } from './server';
import { effectiveConfig } from './settings';

export const ENTRA_PROVIDER_ID = 'microsoft-entra-id';
const AUTH_URL_FROM_ENV = !!process.env.AUTH_URL;
export const SESSION_MAX_AGE_SEC = 12 * 3600;

/** Where Entra must send people back to; shown in Settings → Sign-in for the app registration. */
export function entraRedirectUri(cfg: AppConfig): string {
  return `${cfg.baseUrl}/api/auth/callback/${ENTRA_PROVIDER_ID}`;
}

declare module 'next-auth' {
  interface Session {
    uid?: number;
  }
  interface User {
    masUserId?: number;
  }
}

/**
 * Built per request from the saved settings, so Microsoft sign-in is configured in the browser
 * (Settings → Sign-in) and takes effect without a restart. The session key is derived from the
 * master key; nothing needs adding to a config file.
 */
async function buildConfig(): Promise<NextAuthConfig> {
  const cfg = await effectiveConfig();
  const entra = cfg.auth.entra;
  // Auth.js derives callback URLs from AUTH_URL; pin them to the configured public address
  // (an AUTH_URL set by the operator wins).
  if (!AUTH_URL_FROM_ENV) process.env.AUTH_URL = cfg.baseUrl;
  return {
    secret: server().box.deriveSecret('authjs-session'),
    trustHost: true,
    basePath: '/api/auth',
    session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE_SEC, updateAge: 3600 },
    pages: { signIn: '/login', error: '/login' },
    logger: {
      error: (e) => server().log.warn({ err: e.message, type: e.name }, 'sign-in error'),
      warn: (code) => server().log.debug({ code }, 'auth.js warning'),
      debug: () => {},
    },
    providers: entra
      ? [
          MicrosoftEntraID({
            clientId: entra.clientId,
            clientSecret: entra.clientSecret,
            issuer: `https://login.microsoftonline.com/${entra.tenantId}/v2.0`,
            authorization: { params: { scope: 'openid profile email' } },
            // The stock profile() fetches a photo from Microsoft Graph and fails sign-in when the
            // VM cannot reach it. MAS only needs the ID token claims.
            profile(p) {
              const claims = p as unknown as Record<string, unknown>;
              const s = (k: string) =>
                typeof claims[k] === 'string' ? (claims[k] as string) : null;
              return {
                id: s('oid') ?? s('sub') ?? '',
                name: s('name'),
                email: s('email') ?? s('preferred_username'),
              };
            },
          }),
        ]
      : [],
    callbacks: {
      async signIn({ profile, user }) {
        if (!entra) return '/login?error=not_configured';
        const decision = evaluateEntraSignIn((profile ?? {}) as EntraClaims, entra);
        const meta = await requestMeta();
        const { db, log } = server();
        if (!decision.allowed) {
          log.warn({ email: decision.email, reason: decision.reason }, 'Microsoft sign-in refused');
          await recordDeniedSignIn(db.db, decision, meta);
          return `/login?error=${decision.reason}`;
        }
        const existing = await findUserByOid(db.db, decision.oid);
        if (existing?.disabledAt) {
          await recordDeniedSignIn(db.db, { email: decision.email, reason: 'disabled' }, meta);
          return '/login?error=disabled';
        }
        const row = await upsertEntraUser(db.db, decision, meta);
        user.masUserId = row.id;
        return true;
      },
      jwt({ token, user }) {
        // Keep the cookie small: groups are evaluated at sign-in, the user row holds the result.
        const t = token as typeof token & { uid?: number };
        if (user?.masUserId) t.uid = user.masUserId;
        return { sub: t.sub, uid: t.uid, iat: t.iat, exp: t.exp, jti: t.jti };
      },
      session({ session, token }) {
        session.uid = (token as { uid?: number }).uid;
        return session;
      },
    },
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth(() => buildConfig());
