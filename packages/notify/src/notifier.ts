import type { ChannelKind } from '@mercer/core';

export interface DeliveryResult {
  /** The provider's id for the message (Twilio SID, Pushover request id, Workflows run id). */
  providerRef: string | null;
  /** Where follow-ups can be threaded, if the provider returns it (Teams bot: activity id). */
  threadRef: string | null;
}

/**
 * One delivery channel. Teams Workflows webhooks cannot edit a posted card, so updates are
 * follow-up cards; a phase-2 Teams bot (Action.Execute buttons, in-place updates) implements the
 * same interface with `updatesInPlace` and `inCardActions` set.
 */
export interface Notifier<Payload> {
  readonly kind: ChannelKind;
  readonly capabilities: { updatesInPlace: boolean; inCardActions: boolean };
  send(target: string, payload: Payload): Promise<DeliveryResult>;
}
