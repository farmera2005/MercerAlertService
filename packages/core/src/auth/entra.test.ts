import { describe, expect, it } from 'vitest';
import { evaluateEntraSignIn, parseEmailList, type EntraAccessConfig } from './entra';

const TENANT = '11111111-2222-3333-4444-555555555555';
const ALLOWED = 'aaaaaaaa-0000-0000-0000-000000000001';
const ADMIN = 'aaaaaaaa-0000-0000-0000-000000000002';
const cfg: EntraAccessConfig = {
  tenantId: TENANT,
  allowedGroupId: ALLOWED,
  adminGroupId: ADMIN,
  bootstrapAdminEmails: ['lead@mercer.example'],
};
const base = {
  oid: 'user-oid-1',
  tid: TENANT,
  name: 'Pat Doe',
  preferred_username: 'Pat.Doe@mercer.example',
};

describe('evaluateEntraSignIn', () => {
  it('lets members of the allowed group in, as non-admins by default', () => {
    expect(evaluateEntraSignIn({ ...base, groups: [ALLOWED] }, cfg)).toEqual({
      allowed: true,
      oid: 'user-oid-1',
      email: 'pat.doe@mercer.example',
      name: 'Pat Doe',
      isAdmin: false,
    });
  });

  it('grants admin through the admin group or the bootstrap list', () => {
    expect(
      evaluateEntraSignIn({ ...base, groups: [ALLOWED, ADMIN.toUpperCase()] }, cfg),
    ).toMatchObject({
      isAdmin: true,
    });
    expect(
      evaluateEntraSignIn({ ...base, email: 'Lead@Mercer.example', groups: [ALLOWED] }, cfg),
    ).toMatchObject({ isAdmin: true });
  });

  it('refuses people outside the group, other tenants and group overage', () => {
    expect(evaluateEntraSignIn({ ...base, groups: [ADMIN] }, cfg)).toMatchObject({
      allowed: false,
      reason: 'not_in_group',
    });
    expect(evaluateEntraSignIn({ ...base, groups: [ALLOWED], tid: 'other' }, cfg)).toMatchObject({
      reason: 'wrong_tenant',
    });
    expect(evaluateEntraSignIn({ ...base, _claim_names: { groups: 'src1' } }, cfg)).toMatchObject({
      reason: 'group_overage',
    });
    expect(evaluateEntraSignIn({ ...base }, cfg)).toMatchObject({ reason: 'not_in_group' });
  });

  it('refuses everyone until it is configured', () => {
    expect(
      evaluateEntraSignIn({ ...base, groups: [ALLOWED] }, { ...cfg, allowedGroupId: '' }),
    ).toMatchObject({
      reason: 'not_configured',
    });
  });

  it('parses e-mail lists', () => {
    expect(parseEmailList(' A@x.com, b@x.com;a@x.com\nc@x.com ')).toEqual([
      'a@x.com',
      'b@x.com',
      'c@x.com',
    ]);
  });
});
