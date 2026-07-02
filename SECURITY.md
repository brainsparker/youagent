# Security Policy

## Supported versions

YouAgent is pre-1.0. Only the latest published release receives security
fixes.

| Version | Supported |
| ------- | --------- |
| latest 0.x | ✅ |
| older | ❌ |

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, either:

- Use GitHub's private vulnerability reporting:
  [Report a vulnerability](https://github.com/brainsparker/youagent/security/advisories/new), or
- Email **brian@you.com** with a description, reproduction steps, and impact.

You can expect an acknowledgment within a few days. Please allow a reasonable
window for a fix before public disclosure.

## Scope notes

- YouAgent stores your You.com API key only in the environment
  (`YDC_API_KEY`) — it is never written to the agent card, database, or
  exports. If you find a path where it leaks, that's a vulnerability.
- The A2A server (`A2AServer`) currently does **not** enforce authentication
  (see "Known gaps" in the README). Do not expose it to untrusted networks;
  hardening it is a welcome contribution rather than a reportable
  vulnerability.
