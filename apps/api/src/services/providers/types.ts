/**
 * Provider boundaries.
 *
 * Every external vendor sits behind one of these interfaces, so a Twilio SDK
 * call never appears anywhere except its own adapter and swapping providers is
 * a one-file change. This is the concrete answer to "do not create another
 * architecture where one vendor controls everything".
 */

export interface SmsSendResult {
  providerMessageId: string;
  provider: string;
}

export interface SmsProvider {
  readonly name: string;
  readonly enabled: boolean;
  send(to: string, body: string): Promise<SmsSendResult>;
  /** Returns true when the request genuinely came from the provider. */
  validateWebhookSignature(args: {
    signature: string | undefined;
    url: string;
    params: Record<string, string>;
  }): boolean;
}

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushSendResult {
  provider: string;
  providerMessageId: string | null;
}

export class PushSubscriptionGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushSubscriptionGoneError';
  }
}

export interface PushProvider {
  readonly name: string;
  readonly enabled: boolean;
  send(target: PushTarget, payload: { title: string; body: string; data?: unknown }): Promise<PushSendResult>;
}

export interface PlacedCall {
  providerCallId: string;
  provider: string;
  status: string;
}

export interface CallingProvider {
  readonly name: string;
  readonly enabled: boolean;
  /** Bridges `from` and `to` through the organisation's number. Neither party
   *  ever learns the other's real number. */
  connect(args: {
    initiatorNumber: string;
    destinationNumber: string;
    callId: string;
  }): Promise<PlacedCall>;
  /**
   * Automated call to a volunteer (offer, cancellation). When answered, the
   * provider fetches what to say from our voice-notify webhook for this
   * delivery; the final result arrives on its status callback.
   */
  announce(args: { to: string; deliveryId: string }): Promise<PlacedCall>;
  validateWebhookSignature(args: {
    signature: string | undefined;
    url: string;
    params: Record<string, string>;
  }): boolean;
}

export interface GeocodeResult {
  formatted: string;
  line1: string;
  unit: string | null;
  city: string;
  province: string;
  postalCode: string | null;
  country: string;
  latitude: number | null;
  longitude: number | null;
}

export interface GeocodingProvider {
  readonly name: string;
  search(query: string, limit?: number): Promise<GeocodeResult[]>;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML part. The text part is always authoritative. */
  html?: string;
  replyTo?: string;
}

export interface EmailSendResult {
  provider: string;
  providerMessageId: string;
}

export interface EmailProvider {
  readonly name: string;
  readonly enabled: boolean;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

// ---------------------------------------------------------------------------
// WhatsApp
//
// The organisation already runs a WAHA server. This interface is deliberately
// the same shape as SmsProvider so the notification path treats the two
// identically; WAHA-specific session and chat-id handling stays in its adapter.
// ---------------------------------------------------------------------------

export interface WhatsAppSendResult {
  provider: string;
  providerMessageId: string;
}

export interface WhatsAppProvider {
  readonly name: string;
  readonly enabled: boolean;
  /** `to` is E.164; the adapter converts it to whatever the vendor expects. */
  send(to: string, body: string): Promise<WhatsAppSendResult>;
  /** Reports whether the underlying session is actually connected. */
  health(): Promise<{ ok: boolean; detail: string }>;
}

// ---------------------------------------------------------------------------
// Object storage
// ---------------------------------------------------------------------------

export interface ObjectStore {
  readonly name: string;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Driver licence verification
//
// There is no built-in implementation and no default provider. `verify` is the
// only thing in the system permitted to produce a `verified` licence status,
// and the database refuses that status without the provider name and reference
// this returns (migration 0004).
// ---------------------------------------------------------------------------

export interface LicenceVerificationRequest {
  licenceNumber: string;
  province: string;
  country: string;
  fullName: string;
  dateOfBirth?: string;
}

export interface LicenceVerificationResult {
  /** True ONLY when the provider affirmatively confirmed the licence. */
  verified: boolean;
  /** The provider's own record id for this check. Required when verified. */
  reference: string | null;
  status: 'valid' | 'invalid' | 'expired' | 'unknown' | 'unsupported';
  detail: string;
  checkedAt: Date;
}

export interface LicenceVerificationProvider {
  readonly name: string;
  readonly enabled: boolean;
  verify(request: LicenceVerificationRequest): Promise<LicenceVerificationResult>;
}
