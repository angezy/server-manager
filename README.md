# Sentinel — Ubuntu Server Manager

Sentinel is a self-hosted, evidence-first Ubuntu infrastructure manager. It provides a ChatGPT-style interface, deterministic server-health checks, website investigation, a remote OpenAI-compatible LLM reasoning layer, and a restricted Host Agent. The LLM cannot run a shell: every action is a typed registry entry with fixed executables/arguments, output limits, audit events, risk, and confirmation rules.

## Architecture and security model

React frontend → authenticated Express API → AgentRuntime → remote OpenAI-compatible LLM (optional) ⇄ typed assistant/tool messages → Zod tool registry → risk/confirmation engine → Unix-socket Host Agent → fixed allowlisted operations.

The web/API process is not root. The Host Agent runs as `server-manager`, validates the RPC request again, uses `execFile` with `shell:false`, sanitized environment, timeouts, bounded output, allowlisted paths and names, and structured JSON. The Docker deployment does not expose the Docker socket publicly. Secrets are read from environment variables, redacted in logs, and never returned to the frontend.

Read-only health and explicit website diagnosis work without an LLM. General requests use a bounded multi-step tool loop. Modification requests require a single-use, expiring action hash confirmation; file changes create backups and can be rolled back through the recorded backup. See [docs/agent-tools.md](docs/agent-tools.md) for the tool protocol.

## Quick start (development)

```bash
git clone https://example.invalid/server-manager.git
cd server-manager
npm ci
cp .env.example .env
# Set HOST_AGENT_MODE=local-dev for UI-only development, or run the native Host Agent.
npm run migrate
ADMIN_USERNAME=admin ADMIN_PASSWORD='a-long-unique-password' npm run create-admin
npm run dev
```

Open `http://localhost:5173`. Production defaults to port `3010`; set `PORT` and `HOST` in `.env` to change it.

## Remote LLM configuration

The default provider is OpenRouter via its OpenAI-compatible API. No Ollama or local model is installed or started.

```dotenv
LLM_ENABLED=true
LLM_PROVIDER=openrouter
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=your-key
LLM_MODEL=openrouter/free
LLM_FALLBACK_MODELS=
LLM_TIMEOUT_MS=60000
LLM_MAX_TOKENS=4096
LLM_TEMPERATURE=0.1
LLM_MAX_AGENT_STEPS=8
LLM_MAX_RETRIES=3
```

Use `LLM_BASE_URL` and `LLM_MODEL` for any compatible provider. Run `./scripts/setup-model.sh .env` to test the models endpoint, JSON completion, and streaming. The script masks the key and exits non-zero on failure. Keep `.env` at mode `0600`.

## Commands

```bash
npm run migrate
npm run create-admin
npm test
npm run typecheck
npm run build
docker compose config
sudo nginx -t
sudo bash scripts/backup.sh /etc/nginx/sites-available/example
sudo bash scripts/restore.sh /var/backups/server-manager/YYYY-MM-DD_HH-mm-ss/example
```

## API

Public: `GET /api/health`, `GET /api/status`, `POST /api/auth/login`. Authenticated endpoints cover sessions, conversations, messages, chat, SSE at `GET /api/chat/stream/:requestId`, confirmations, health, diagnosis, audit, and admin LLM status/test. Secure cookies, SameSite, CSRF token headers, rate limiting, Helmet, CORS allowlisting, body limits and sanitized errors are enabled.

## Native installation and Docker

See [docs/deployment.md](docs/deployment.md). Install Node.js 22 LTS, run `scripts/install.sh`, build, migrate, create the first admin, and enable `systemd/server-manager-agent.service` and `systemd/server-manager-api.service`. The service files use `NoNewPrivileges`, `ProtectSystem`, `ProtectHome`, private temp directories, and explicit writable paths. For Docker, the API only mounts `/run/server-manager/agent.sock` and persistent data/log volumes; it never mounts `/var/run/docker.sock`.

## Operations and troubleshooting

Ask “Is my server healthy?” for CPU, RAM, swap, disk, load, Docker, PM2, Nginx, ports, failed services, critical logs, and evidence timestamps. Ask “Why is my website down?” with a domain for ordered investigation; if no domain is configured, Sentinel asks which one. Any Hiddify request uses the inventory/cleanup workflow, even if it mentions a website or Nginx. It does not restart services or edit files automatically.

Logs are JSONL in `LOG_DIR`: `application.jsonl`, `ai.jsonl`, `tool.jsonl`, `security.jsonl`, and `audit.jsonl`. Rotate them with logrotate or your host logging policy, keep mode `0640`, and never ship `.env`. Backups belong under `/var/backups/server-manager/` with metadata and SHA-256 checksums.

For a controlled Node deployment, configure exact `DEPLOYMENT_PATH_ALLOWLIST` and `DEPLOYMENT_DOMAIN_ALLOWLIST` entries plus the PM2 process in `PM2_ALLOWLIST`. The agent can then accept a request such as “deploy `/var/www/vhosts/laon-demo` as `loan-demo` for `loan-demo.nickwebproject.com`,” ask for any missing port or Certbot email, show one exact confirmation, and execute the bounded PM2 → Nginx → validation/reload → Certbot workflow. It never accepts a user- or model-supplied shell command.

## Limitations

The base profile intentionally limits file operations to narrow allowlisted roots; it supports validation, backup, reload, restore, rollback, and exact artifact deletion. PM2/Docker/systemd actions require explicit allowlists in the Host Agent environment. Provider-specific tool-calling quirks are handled by model fallback, retries, timeouts, and transport validation; the runtime does not parse model-authored plans.
