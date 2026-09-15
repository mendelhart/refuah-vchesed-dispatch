process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://postgres@127.0.0.1:5432/rvc_test';
process.env.SESSION_SECRET ??= 'test-secret-test-secret-test-secret-64chars-long-enough';
process.env.APP_URL ??= 'http://localhost:5173';
process.env.API_PUBLIC_URL ??= 'http://localhost:8080';
process.env.COOKIE_SECURE = 'false';
process.env.RUN_WORKER_IN_PROCESS = 'false';
process.env.LOG_LEVEL = process.env.TEST_LOG ?? 'fatal';

// The public signup endpoint is rate-limited to a handful of submissions per IP
// per hour, which is right in production and would throttle a test file that
// submits a dozen. The limit is raised here and exercised deliberately in
// applications.test.ts against its own IP.
process.env.SIGNUP_MAX_PER_IP_PER_HOUR = '100';

// Licence numbers and images are encrypted at rest and the code refuses to
// store them otherwise, so the suite needs a key. Test-only value; production
// generates its own (see .env.example).
process.env.FIELD_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
