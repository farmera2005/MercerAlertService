/**
 * Who may sign in with Microsoft Entra ID, decided from the ID token claims alone. Membership of
 * one security group is required; the admin flag comes from a second group or a bootstrap e-mail
 * list. Group overage (a `_claim_names.groups` pointer instead of a list) is refused with a clear
 * reason: configure the app registration to emit "Groups assigned to the application".
 */

export interface EntraAccessConfig {
  tenantId: string;
  allowedGroupId: string;
  adminGroupId: string;
  bootstrapAdminEmails: readonly string[];
}

export interface EntraClaims {
  oid?: unknown;
  tid?: unknown;
  sub?: unknown;
  name?: unknown;
  email?: unknown;
  preferred_username?: unknown;
  upn?: unknown;
  groups?: unknown;
  _claim_names?: unknown;
  hasgroups?: unknown;
}

export type EntraDenyReason = 'not_configured' | 'wrong_tenant' | 'not_in_group' | 'group_overage';

export type EntraDecision =
  | { allowed: true; oid: string; email: string; name: string; isAdmin: boolean }
  | { allowed: false; reason: EntraDenyReason; email: string | null };

export const ENTRA_DENY_MESSAGES: Record<EntraDenyReason, string> = {
  not_configured: 'Microsoft sign-in is not set up yet. Sign in with a local administrator.',
  wrong_tenant: 'That Microsoft account belongs to a different organisation.',
  not_in_group:
    'Your account is not in the security group allowed to use this dashboard. Ask IT to add you.',
  group_overage:
    'Your account is in too many groups for Entra to list them in the sign-in token. An administrator must set the app registration to emit "Groups assigned to the application".',
};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isGuid = (s: string) => GUID.test(s);

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function parseEmailList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export function evaluateEntraSignIn(claims: EntraClaims, cfg: EntraAccessConfig): EntraDecision {
  const email =
    (str(claims.email) ?? str(claims.preferred_username) ?? str(claims.upn))?.toLowerCase() ?? null;
  if (!cfg.tenantId || !cfg.allowedGroupId)
    return { allowed: false, reason: 'not_configured', email };
  const tid = str(claims.tid);
  if (isGuid(cfg.tenantId) && tid?.toLowerCase() !== cfg.tenantId.toLowerCase())
    return { allowed: false, reason: 'wrong_tenant', email };

  const groups = Array.isArray(claims.groups)
    ? claims.groups.filter((g): g is string => typeof g === 'string').map((g) => g.toLowerCase())
    : null;
  const overage =
    !groups &&
    (claims.hasgroups === true ||
      (typeof claims._claim_names === 'object' &&
        claims._claim_names !== null &&
        'groups' in claims._claim_names));
  if (overage) return { allowed: false, reason: 'group_overage', email };
  if (!groups?.includes(cfg.allowedGroupId.toLowerCase()))
    return { allowed: false, reason: 'not_in_group', email };

  const oid = str(claims.oid) ?? str(claims.sub);
  if (!oid) return { allowed: false, reason: 'not_in_group', email };
  const isAdmin =
    (!!cfg.adminGroupId && groups.includes(cfg.adminGroupId.toLowerCase())) ||
    (!!email && cfg.bootstrapAdminEmails.includes(email));
  return {
    allowed: true,
    oid,
    email: email ?? '',
    name: str(claims.name) ?? email ?? oid,
    isAdmin,
  };
}
