# Security Policy

## Supported versions

Security fixes target the latest published release in the current major release line (3.x). Upgrade to the latest patch before reporting a suspected issue. Older release lines are unsupported.

## Private vulnerability reports

Use [GitHub private vulnerability reporting](https://github.com/lafittemehdy/graphql-upload-nextjs/security/advisories/new), or email lafittemehdy@gmail.com if that channel is unavailable. Do not include exploits, credentials, personal data, or undisclosed vulnerability details in public issues.

Include affected versions, impact, prerequisites, a minimal safe reproduction, and any known workaround. Maintainers will coordinate investigation and disclosure; no fixed response time or security guarantee is promised.

## Deployment boundaries

Uploads require request limits, authentication, authorization, storage quotas, and a deployment that enforces those limits. MIME detection is not malware scanning. The example download route is public and is not a production authorization model.

See the README Apollo Server advisory note for the application-side dependency override required by the current Apollo Server 5 release. Repository overrides do not propagate into consuming applications.
