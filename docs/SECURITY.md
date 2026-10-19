# Security and data boundaries

Store credentials only through the deployment platform's secret mechanism. Never commit OAuth tokens, Discord tokens/client secrets, QQ app secrets, HMAC keys, real owner IDs, binding exports or user task records. The example values are placeholders.

Diagnostic reads use fixed allowlisted fields/codes rather than raw payloads or secrets. The normal diagnostic query window is at most 72 hours and 1,000 records. That limit is not a promise that task history, all logs, receipts, database backups or provider recovery history are erased after 72 hours. Cloudflare SQLite Durable Objects recovery can retain recoverable database history beyond the application query window.

The task snapshot path is source-scoped and SELECT-only, including cold-start access. It does not refresh source evidence, dispatch queues, write alarms or diagnostic records. The health route is a configuration probe and can perform owner lookup and diagnostic writes; do not treat it as a side-effect-free task snapshot.

Do not put private configuration or provider response bodies into public bug reports. Share sanitized codes and reproduction steps using synthetic records. New integrations must receive only the intended source/project scope.
