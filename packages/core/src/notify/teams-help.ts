/**
 * Plain-language help for Teams Workflows webhooks: what a failed test send usually means, and
 * whether a saved URL is the old kind Microsoft stopped accepting.
 */

/**
 * Power Automate stopped accepting Teams webhook URLs on *.logic.azure.com after
 * 30 November 2025; current workflows have *.environment.api.powerplatform.com URLs.
 */
export function isLegacyWorkflowUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith('.logic.azure.com');
  } catch {
    return false;
  }
}

const COPY_AGAIN =
  'open the Workflows app in Teams, select the workflow, choose Edit, expand the first step (“When a Teams webhook request is received”) and copy its URL';

/** What to do about a failed delivery to a Teams workflow, from the provider's error. */
export function teamsFailureHint(error: string): string | null {
  const status = /HTTP (\d{3})/.exec(error)?.[1];
  if (status === '401' || status === '403')
    return 'The workflow only accepts signed-in callers. In Teams, open the Workflows app, select the workflow, choose Edit, open “When a Teams webhook request is received” and set “Who can trigger the flow?” to Anyone. Save, then test again.';
  if (status === '404')
    return `The workflow no longer exists, or this is an old URL (Microsoft stopped accepting logic.azure.com workflow URLs after 30 November 2025). To get the current URL, ${COPY_AGAIN}, then paste it here.`;
  if (status === '400')
    return 'The workflow refused the message. Create it from the “Send webhook alerts to a channel” template, which accepts the Adaptive Cards MAS sends.';
  if (status === '429') return 'Teams is throttling this workflow. MAS retries on its own.';
  if (/unreachable/.test(error))
    return 'The MAS server could not reach the workflow. Allow outbound HTTPS to *.environment.api.powerplatform.com, or set up the web proxy (install guide §13).';
  return null;
}
