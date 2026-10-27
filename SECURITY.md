# Security

This is a self-hosted, multi-account budgeting application, not a bank integration. Each user and their agents share one isolated ledger; no anonymous signup is enabled.

- Keep the service behind a trusted TLS reverse proxy when remote access is needed. Bind the upstream port to loopback or a private container network. Configure the exact `POCKETQUOTA_ORIGIN` and preserve Host; add rate/concurrency/time limits at the proxy.
- `.data/`, `.demo-data/`, databases, tokens, private exports, and `.env` must not enter version control.
- Default admin password is randomly generated (26 characters) on first boot. The initial local credentials file is mode 0600 and deleted after first successful login. Passwords use random salts and scrypt N=2^15, r=8, p=3, as documented by the [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
- Store one credential per agent. Start read-only; enable write/manage only when needed. Manage scope cannot mint other credentials.
- Browser sessions are HttpOnly, SameSite=Strict and 12-hour maximum lifetime; HTTPS origins add Secure. Writes require exact Origin and a session CSRF token. Restart invalidates browser sessions.
- Agent tokens are random and stored only as SHA-256 hashes. A separate local management API token is a mode-0600 file; do not give it to agents. User agent tokens map to exactly one account. Password resets revoke sessions and agent tokens; resetting the default admin also rotates its management token. No tokens in URLs or logs.
- The MCP bridge does not follow redirects, bypass TLS verification or route through an environment proxy. It requires HTTPS except for loopback addresses.
- Journal notes are untrusted input, rendered as text. CSP blocks third-party scripts. CSV strings are protected against formula injection.
- No bank access, OAuth integration, open registration, plugin-store submission, third-party penetration test, or end-to-end encryption is claimed. Site administrators can reset user passwords and filesystem administrators can access all databases. Filesystem administrators can read the ledger. Backups are sensitive.

Report security issues without posting private financial data or secrets. Use the repository's private vulnerability reporting if enabled; otherwise contact the maintainer to arrange a private report. Do not publish an exploitable secret in a public issue.
