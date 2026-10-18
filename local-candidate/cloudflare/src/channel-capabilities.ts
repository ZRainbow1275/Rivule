/** Local-only channel planning contract. No provider SDK, network, storage or send implementation. */
export type ChannelKind = 'qq_c2c' | 'qq_group' | 'discord_dm';
export type CapabilityState = 'verified' | 'unsupported' | 'unknown';
export type Presentation = 'text' | 'image' | 'interactive_card';
export type DeliveryState = 'not_attempted' | 'definitely_not_sent' | 'uncertain' | 'sent';

/** Private server configuration. Neither event bodies nor upstream models choose the target. */
export interface FixedChannelBinding {
  channel: ChannelKind;
  ownerId: string;
  accountId: string;
  destinationId: string;
  allowedSources: readonly string[];
  allowedProjects: readonly string[];
}
export interface ChannelCapabilities {
  mode: 'mock_only';
  enabled: boolean;
  binding: FixedChannelBinding;
  /** Synthetic evidence in these tests; real account evidence is a future integration requirement. */
  checkedAt: number;
  validUntil: number;
  identity: CapabilityState;
  proactive: CapabilityState;
  reply: CapabilityState;
  presentation: Readonly<Record<Presentation, CapabilityState>>;
}
export interface ReplyWindow {
  accountId: string;
  destinationId: string;
  channel: ChannelKind;
  messageId: string;
  validUntil: number;
  /** Unknown quota cannot be treated as unlimited. No platform quota is hard-coded. */
  remaining: number | null;
}
export interface ChannelIntent {
  ownerId: string;
  sourceId: string;
  projectId: string;
  eventId: string;
  deliveryState: DeliveryState;
  purpose: 'proactive' | 'reply';
  presentation: Presentation;
  allowTextDegradation: boolean;
  replyWindow?: ReplyWindow;
}
export type BlockReason = 'invalid_contract' | 'disabled' | 'binding_not_authorized' |
  'capabilities_expired' | 'identity_unverified' | 'proactive_unverified' |
  'reply_unverified' | 'reply_window_unverified' | 'presentation_unverified' |
  'fallback_requires_authorization' | 'fallback_not_applicable';
export type ChannelPlan =
  | {state: 'ready_mock'; mode: 'mock_only'; channel: ChannelKind; presentation: Presentation; degraded: boolean}
  | {state: 'blocked'; mode: 'mock_only'; reason: BlockReason}
  | {state: 'hold_uncertain' | 'already_sent'; mode: 'mock_only'};
const blocked = (reason: BlockReason): ChannelPlan => ({state: 'blocked', mode: 'mock_only', reason});
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const channelKinds: readonly string[] = ['qq_c2c', 'qq_group', 'discord_dm'];
const presentations: readonly string[] = ['text', 'image', 'interactive_card'];

/** Planning never sends and cannot turn a mock result into live-channel authorization. */
export function planChannelDelivery(capabilities: ChannelCapabilities, intent: ChannelIntent, now: number): ChannelPlan {
  if (!capabilities || !intent || !Number.isFinite(now) || capabilities.mode !== 'mock_only') return blocked('invalid_contract');
  if (intent.deliveryState === 'uncertain') return {state: 'hold_uncertain', mode: 'mock_only'};
  if (intent.deliveryState === 'sent') return {state: 'already_sent', mode: 'mock_only'};
  const binding = capabilities.binding;
  if (!binding || !channelKinds.includes(binding.channel) ||
      ![binding.ownerId, binding.accountId, binding.destinationId, intent.ownerId, intent.sourceId, intent.projectId, intent.eventId].every(nonempty) ||
      !Array.isArray(binding.allowedSources) || !Array.isArray(binding.allowedProjects) ||
      !['not_attempted', 'definitely_not_sent'].includes(intent.deliveryState) ||
      !['proactive', 'reply'].includes(intent.purpose) || !presentations.includes(intent.presentation) ||
      typeof intent.allowTextDegradation !== 'boolean') return blocked('invalid_contract');
  if (capabilities.enabled !== true) return blocked('disabled');
  if (binding.ownerId !== intent.ownerId || !binding.allowedSources.includes(intent.sourceId) ||
      !binding.allowedProjects.includes(intent.projectId)) return blocked('binding_not_authorized');
  if (!Number.isFinite(capabilities.checkedAt) || !Number.isFinite(capabilities.validUntil) ||
      capabilities.checkedAt > now || capabilities.validUntil <= now || capabilities.checkedAt >= capabilities.validUntil) return blocked('capabilities_expired');
  if (capabilities.identity !== 'verified') return blocked('identity_unverified');
  if (intent.purpose === 'proactive' && capabilities.proactive !== 'verified') return blocked('proactive_unverified');
  if (intent.purpose === 'reply') {
    if (capabilities.reply !== 'verified') return blocked('reply_unverified');
    const window = intent.replyWindow;
    if (!window || window.accountId !== binding.accountId || window.destinationId !== binding.destinationId ||
        window.channel !== binding.channel || !nonempty(window.messageId) || !Number.isFinite(window.validUntil) || window.validUntil <= now ||
        !Number.isSafeInteger(window.remaining) || window.remaining === null || window.remaining <= 0) return blocked('reply_window_unverified');
  }
  const requested = capabilities.presentation?.[intent.presentation];
  if (requested === 'verified') return {state: 'ready_mock', mode: 'mock_only', channel: binding.channel, presentation: intent.presentation, degraded: false};
  if (intent.allowTextDegradation && capabilities.presentation?.text === 'verified') {
    return {state: 'ready_mock', mode: 'mock_only', channel: binding.channel, presentation: 'text', degraded: true};
  }
  return blocked('presentation_unverified');
}

/** An exact-event authorization, supplied by a trusted local caller, never read from task text. */
export interface DiscordFallbackAuthorization {
  consent: 'explicit';
  ownerId: string;
  sourceId: string;
  projectId: string;
  eventId: string;
  fromAccountId: string;
  fromChannel: 'qq_c2c' | 'qq_group';
  fromDestinationId: string;
  toAccountId: string;
  toDestinationId: string;
  validUntil: number;
}
const fallbackReasons = new Set<BlockReason>([
  'capabilities_expired', 'identity_unverified', 'proactive_unverified',
  'reply_unverified', 'reply_window_unverified', 'presentation_unverified'
]);

/** Re-evaluates both sides. No fallback for a possible send, an unapproved source or a ready primary. */
export function planDiscordFallback(
  primary: ChannelCapabilities,
  discord: ChannelCapabilities,
  intent: ChannelIntent,
  authorization: DiscordFallbackAuthorization | undefined,
  now: number,
): ChannelPlan {
  const original = planChannelDelivery(primary, intent, now);
  if (original.state === 'hold_uncertain' || original.state === 'already_sent') return original;
  if (original.state !== 'blocked' || !fallbackReasons.has(original.reason) ||
      !['qq_c2c', 'qq_group'].includes(primary.binding.channel) || discord?.binding?.channel !== 'discord_dm') return blocked('fallback_not_applicable');
  const a = authorization, from = primary.binding, to = discord.binding;
  if (!a || a.consent !== 'explicit' || !Number.isFinite(a.validUntil) || a.validUntil <= now ||
      a.ownerId !== intent.ownerId || a.sourceId !== intent.sourceId || a.projectId !== intent.projectId || a.eventId !== intent.eventId ||
      a.fromAccountId !== from.accountId || a.fromChannel !== from.channel || a.fromDestinationId !== from.destinationId ||
      a.toAccountId !== to.accountId || a.toDestinationId !== to.destinationId) return blocked('fallback_requires_authorization');
  // A QQ reply reference never grants a Discord reply window. Fallback is a separate proactive send.
  return planChannelDelivery(discord, {...intent, purpose: 'proactive', replyWindow: undefined}, now);
}
