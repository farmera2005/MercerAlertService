import { describe, expect, it } from 'vitest';
import { isLegacyWorkflowUrl, teamsFailureHint } from './teams-help';

describe('Teams workflow help', () => {
  it('recognises the old logic.azure.com URLs', () => {
    expect(
      isLegacyWorkflowUrl(
        'https://prod-12.westus.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=x',
      ),
    ).toBe(true);
    expect(
      isLegacyWorkflowUrl(
        'https://default0123.ab.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke?sig=x',
      ),
    ).toBe(false);
    expect(isLegacyWorkflowUrl('not a url')).toBe(false);
  });

  it('explains the usual failures', () => {
    expect(
      teamsFailureHint('teams returned HTTP 401: {"error":"DirectApiAuthorizationRequired"}'),
    ).toMatch(/Who can trigger the flow\?” to Anyone/);
    expect(teamsFailureHint('teams returned HTTP 404: {"error":"WorkflowNotFound"}')).toMatch(
      /logic\.azure\.com workflow URLs after 30 November 2025/,
    );
    expect(teamsFailureHint('teams returned HTTP 400: bad')).toMatch(
      /Send webhook alerts to a channel/,
    );
    expect(teamsFailureHint('teams unreachable: ENOTFOUND')).toMatch(
      /environment\.api\.powerplatform\.com/,
    );
    expect(teamsFailureHint('teams returned HTTP 500')).toBeNull();
  });
});
