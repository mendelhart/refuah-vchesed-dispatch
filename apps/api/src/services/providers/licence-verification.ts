import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import type {
  LicenceVerificationProvider,
  LicenceVerificationRequest,
  LicenceVerificationResult,
} from './types.js';

/**
 * Driver licence verification.
 *
 * READ THIS BEFORE CHANGING ANYTHING HERE.
 *
 * There is no such thing as verifying a Quebec driver's licence from software
 * the SAAQ has not authorised. No public API exposes licence validity, and
 * anything that claims to is either a paid identity-verification vendor with a
 * contract behind it, or a lie. So this file contains exactly two things:
 *
 *  1. `nullLicenceVerificationProvider` — the default. It reports
 *     `status: 'unsupported'` and `verified: false`. Always. It does not
 *     inspect the number, guess from its format, or return anything an
 *     administrator could mistake for a check having happened.
 *
 *  2. `httpLicenceVerificationProvider` — a client for a real verification
 *     service the organisation may contract with later. It is inert until
 *     LICENCE_VERIFICATION_URL is configured, and it marks a licence verified
 *     only when that service affirmatively says so AND returns a reference.
 *
 * The database enforces the same rule independently: `driver_licences` refuses
 * `status = 'verified'` unless the provider name, its reference and a timestamp
 * are all present (migration 0004). Two locks, because "the system says his
 * licence is valid" is a sentence somebody will one day say in a room where it
 * matters.
 */

export const nullLicenceVerificationProvider: LicenceVerificationProvider = {
  name: 'none',
  enabled: false,
  async verify(): Promise<LicenceVerificationResult> {
    return {
      verified: false,
      reference: null,
      status: 'unsupported',
      detail:
        'No licence verification service is configured. The image and number are on file for a person to check; nothing has been verified.',
      checkedAt: new Date(),
    };
  },
};

export const httpLicenceVerificationProvider: LicenceVerificationProvider = {
  name: 'http',
  enabled: env.LICENCE_VERIFICATION_PROVIDER === 'http' && Boolean(env.LICENCE_VERIFICATION_URL),

  async verify(request: LicenceVerificationRequest): Promise<LicenceVerificationResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(env.LICENCE_VERIFICATION_URL!, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(env.LICENCE_VERIFICATION_API_KEY
            ? { authorization: `Bearer ${env.LICENCE_VERIFICATION_API_KEY}` }
            : {}),
        },
        body: JSON.stringify({
          licenceNumber: request.licenceNumber,
          jurisdiction: `${request.country}-${request.province}`,
          fullName: request.fullName,
          dateOfBirth: request.dateOfBirth,
        }),
      });

      if (!res.ok) {
        return {
          verified: false,
          reference: null,
          status: 'unknown',
          detail: `Verification service returned HTTP ${res.status}`,
          checkedAt: new Date(),
        };
      }

      const body = (await res.json()) as {
        status?: string;
        reference?: string;
        detail?: string;
      };

      // A positive result without a reference is not a positive result: without
      // it there is nothing to point at later, so it is recorded as unknown.
      const affirmative = body.status === 'valid' && Boolean(body.reference);
      if (body.status === 'valid' && !body.reference) {
        logger.warn('licence verification returned valid without a reference; treating as unknown');
      }

      return {
        verified: affirmative,
        reference: body.reference ?? null,
        status: (body.status as LicenceVerificationResult['status']) ?? 'unknown',
        detail: body.detail ?? '',
        checkedAt: new Date(),
      };
    } catch (err) {
      logger.error({ err }, 'licence verification request failed');
      return {
        verified: false,
        reference: null,
        status: 'unknown',
        detail: (err as Error).message,
        checkedAt: new Date(),
      };
    } finally {
      clearTimeout(timer);
    }
  },
};
