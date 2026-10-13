import { startAuthServer } from '@/auth/application/bootstrap.js';

// This is the only executable entrypoint; importing a feature must not start HTTP.
await startAuthServer();
