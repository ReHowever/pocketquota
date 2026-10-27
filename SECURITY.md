# Security

This is a self-hosted, single-owner budgeting application, not a multi-tenant service or a bank integration.

- Keep the service behind a trusted TLS reverse proxy when remote access is needed. Bind the upstream port to loopback or a private container network. Configure the exact `POCKETQUOTA_ORIGIN` and preserve Host; add rate/concurrency/time limits at the proxy.
- `.data/`, `.demo-data/`, databases, tokens, private exports, and `.env` must not enter version control.
- Store one credential per agent. Start read-only; enable write/manage only when needed. Manage scope cannot mint other credentials.
- Browser sessions are HttpOnly, SameSite=Strict and 12-hour maximum lifetime; HTTPS origins add Secure. Writes require exact Origin and a session CSRF token. Restart invalidates browser sessions.
- Agent tokens are random and stored only as SHA-256 hashes. Owner token is a mode-0600 local file; revoke/change credentials if exposed. No tokens in URLs or logs.
- The MCP bridge does not follow redirects, bypass TLS verification or route through an environment proxy. It requires HTTPS except for loopback addresses.
- Journal notes are untrusted input, rendered as text. CSP blocks third-party scripts. CSV strings are protected against formula injection.
- No bank access, OAuth integration, plugin-store submission, third-party penetration test, or end-to-end encryption is claimed. Filesystem administrators can read the ledger. Backups are sensitive.

Report security issues without posting private financial data or secrets. Use the repository's private vulnerability reporting if enabled; otherwise contact the maintainer to arrange a private report. Do not publish an exploitable secret in a public issue.
