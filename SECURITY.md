# Security policy

Report vulnerabilities privately to the project maintainer. Do not include live API keys, passwords, cookies, private keys, production logs, or customer data in an issue.

Security invariants:

- No generic `exec`, `shell`, `docker exec`, or user-supplied executable exists.
- All Host Agent operations validate the tool name and argument schema twice.
- Fixed commands use `execFile` and `shell:false`, fixed executable paths, bounded output, timeouts, and a sanitized environment.
- Paths reject traversal and must match an explicit allowlist.
- Passwords use Argon2id; sessions are opaque, hashed, revocable and expiring.
- State-changing browser requests require the CSRF cookie/header pair.
- LLM keys stay backend-only and are redacted from structured logs.
- Controlled operations require an expiring, single-use confirmation bound to an action hash.
- Backups are checksum-verified before restore and the current file is backed up first.

Run `npm run lint:security`, `npm test`, and review `systemd/server-manager-sudoers.example` before production deployment. Run the service as the dedicated non-root user and expose the API through a TLS reverse proxy with a firewall that does not expose the agent socket.
