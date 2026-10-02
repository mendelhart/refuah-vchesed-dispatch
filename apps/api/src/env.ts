import { z } from 'zod';

/**
 * All configuration in one place, validated at boot. The process refuses to
 * start with a bad config rather than failing later in a request.
 */
const bool = (def: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (v === undefined ? def : v === true || v === 'true' || v === '1'));

const envSchema = z.object({
  PERSONAL_RETENTION_ENABLED: bool(false),
  REMOVED_LICENCE_RETENTION_MONTHS: z.coerce.number().int().positive().optional(),
  REJECTED_APPLICATION_RETENTION_MONTHS: z.coerce.number().int().positive().optional(),
  OLD_TRIP_PERSONAL_RETENTION_MONTHS: z.coerce.number().int().positive().optional(),
  DATABASE_EXPIRES_AT: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  /** Public origin of the web app; used for cookies, CORS and deep links. */
  APP_URL: z.string().url().default('http://localhost:5173'),
  /** Public origin of this API; used to build Twilio webhook URLs. */
  API_PUBLIC_URL: z.string().url().default('http://localhost:8080'),

  SESSION_COOKIE_NAME: z.string().default('rvc_session'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  COOKIE_SECURE: bool(false),
  /** Two-step sign-in for coordinators and admins. Unset = on in production only. */
  MFA_REQUIRED: z.enum(['true', 'false', '1', '0']).optional(),

  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  /** Skips signature validation. Only ever allowed outside production. */
  TWILIO_SKIP_SIGNATURE_VALIDATION: bool(false),

  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:admin@refuahvchesed.org'),

  GEOCODER_USER_AGENT: z.string().default('RefuahVChesedDispatch/1.0'),
  GEOCODER_BASE_URL: z.string().url().default('https://nominatim.openstreetmap.org'),
  GEOCODER_BIAS: z.string().default('Montreal, QC, Canada'),

  // --- Email (transactional) ------------------------------------------------
  // 'none' selects the in-memory provider: mail is recorded as a delivery row
  // and logged, never sent. That is the default outside production so a dev
  // machine can never email a real volunteer.
  EMAIL_PROVIDER: z.enum(['none', 'smtp']).default('none'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: bool(false),
  EMAIL_FROM: z.string().default("Refuah V'Chesed <dispatch@refuahvchesed.org>"),
  EMAIL_REPLY_TO: z.string().optional(),

  // --- WhatsApp (WAHA) ------------------------------------------------------
  // The organisation already runs a WAHA server; we speak its HTTP API rather
  // than replacing it. Absent config selects the in-memory provider.
  WAHA_BASE_URL: z.string().url().optional(),
  WAHA_API_KEY: z.string().optional(),
  WAHA_SESSION: z.string().default('default'),
  /** HMAC key set on the WAHA session webhook; incoming WhatsApp replies are
   *  rejected in production unless signed with it. */
  WAHA_WEBHOOK_SECRET: z.string().optional(),

  // --- File storage ---------------------------------------------------------
  FILE_STORAGE_DRIVER: z.enum(['local', 's3', 'db']).default('local'),
  FILE_STORAGE_PATH: z.string().default('./var/files'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  /**
   * 32-byte key, base64, for AES-256-GCM field encryption (licence numbers and
   * licence images at rest). Required in production; absent elsewhere means
   * those features refuse to store anything rather than storing it in clear.
   */
  FIELD_ENCRYPTION_KEY: z.string().optional(),
  FIELD_ENCRYPTION_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).optional(),
  FIELD_ENCRYPTION_OLD_KEYS: z.string().optional(),
  FIELD_ENCRYPTION_ROTATE_ON_BOOT: bool(false),

  // --- Driver licence verification -----------------------------------------
  // There is no default provider and no built-in verification. With this unset,
  // a licence can only ever reach status 'on_file' — never 'verified'.
  LICENCE_VERIFICATION_PROVIDER: z.enum(['none', 'http']).default('none'),
  LICENCE_VERIFICATION_URL: z.string().url().optional(),
  LICENCE_VERIFICATION_API_KEY: z.string().optional(),

  /**
   * First-run administrator, for hosts with no shell (see db/bootstrap-admin.ts).
   *
   * Setting this on an empty system creates one administrator with no password
   * and logs a single-use invitation link. It is ignored once that account has
   * a password, and ignored outright on a system that already has users.
   */
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_NAME: z.string().default('Administrator'),

  /**
   * Test mode for a trial deployment. When true, any messaging channel without
   * real credentials (SMS, voice, WhatsApp, email, push) uses the in-memory
   * provider: the message is recorded as delivered in the notification log and
   * nothing leaves the server. Configured channels still send for real.
   * Without this flag a production server with no Twilio/WAHA fails every send.
   */
  MESSAGING_TEST_MODE: bool(false),

  // --- Public signup --------------------------------------------------------
  PUBLIC_SIGNUP_ENABLED: bool(true),
  SIGNUP_MAX_PER_IP_PER_HOUR: z.coerce.number().int().min(1).max(100).default(5),

  /**
   * Sign-in attempts allowed per IP per five minutes.
   *
   * The default is the real control against credential stuffing and should not
   * be raised in production. It is configurable because the browser suite signs
   * in as three roles against one IP, and repeated local runs would otherwise
   * throttle themselves and fail with timeouts that look like application bugs.
   * scripts/e2e.sh raises it; the limiter itself is tested in auth.test.ts.
   */
  LOGIN_MAX_PER_IP_PER_5MIN: z.coerce.number().int().min(1).max(1000).default(10),

  /** Honour the Idempotency-Key header on signed-in writes (lib/idempotency.ts).
   *  Off by default: the header is ignored and nothing changes. */
  IDEMPOTENCY_KEYS_ENABLED: bool(false),

  // --- New features (all off by default; see lib/flags.ts) -----------------
  /** Round trips, extra stops and several passengers per ride. */
  MULTI_LEG_TRIPS_ENABLED: bool(false),
  /** Coordinators who belong to departments work only within them. */
  DEPARTMENT_SCOPING_ENABLED: bool(false),

  SENTRY_DSN: z.string().optional(),
  HEALTH_CHECK_TOKEN: z.string().min(16).optional(),

  /** Run the background worker inside the API process (fine up to a few
   *  thousand jobs/day); set false to run `node dist/jobs/worker.js` separately. */
  RUN_WORKER_IN_PROCESS: bool(true),

  /**
   * Read by scripts/docker-entrypoint.sh, and declared here so `env.ts` remains
   * the complete list of what configures this service. Set false where the
   * platform runs migrations as a release step (Fly's `release_command` does),
   * so they do not also run on every machine as it boots.
   */
  RUN_MIGRATIONS_ON_START: bool(true),
  WORKER_POLL_MS: z.coerce.number().int().min(200).max(60_000).default(2_000),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
});

export type Env = z.infer<typeof envSchema>;

function load(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;

  if (env.FIELD_ENCRYPTION_KEY) {
    const bytes = Buffer.from(env.FIELD_ENCRYPTION_KEY, 'base64');
    if (bytes.length !== 32) {
      throw new Error(
        `FIELD_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${bytes.length}). Generate one with: openssl rand -base64 32`,
      );
    }
  }
  if (env.FIELD_ENCRYPTION_OLD_KEYS) {
    for (const part of env.FIELD_ENCRYPTION_OLD_KEYS.split(',').map((p) => p.trim()).filter(Boolean)) {
      const i = part.indexOf(':');
      if (i <= 0 || Buffer.from(part.slice(i + 1), 'base64').length !== 32) {
        throw new Error('FIELD_ENCRYPTION_OLD_KEYS must be a comma list of id:base64key, each key 32 bytes');
      }
    }
  }

  if (env.NODE_ENV === 'production') {
    if (env.TWILIO_SKIP_SIGNATURE_VALIDATION) {
      throw new Error('TWILIO_SKIP_SIGNATURE_VALIDATION must be false in production');
    }
    if (!env.COOKIE_SECURE) {
      throw new Error('COOKIE_SECURE must be true in production');
    }
    if (!env.FIELD_ENCRYPTION_KEY) {
      throw new Error(
        'FIELD_ENCRYPTION_KEY is required in production: driver licence numbers and images are encrypted at rest.',
      );
    }
    if (env.EMAIL_PROVIDER === 'smtp' && !env.SMTP_HOST) {
      throw new Error('EMAIL_PROVIDER=smtp requires SMTP_HOST');
    }
    if (env.LICENCE_VERIFICATION_PROVIDER === 'http' && !env.LICENCE_VERIFICATION_URL) {
      throw new Error('LICENCE_VERIFICATION_PROVIDER=http requires LICENCE_VERIFICATION_URL');
    }
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
      // Not fatal, but push will be disabled; make that explicit at boot.
      // eslint-disable-next-line no-console
      console.warn('[config] VAPID keys absent — push notifications are disabled');
    }
  }
  return env;
}

export const env: Env = load();

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
