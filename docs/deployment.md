# Deployment

## Native Ubuntu

Ubuntu 22.04 and 24.04 are supported. Install Node.js 22 LTS, clone the repository, run `sudo ./scripts/install.sh`, then configure `.env`:

```bash
sudo mkdir -p /opt/server-manager && sudo chown "$USER" /opt/server-manager
git clone https://example.invalid/server-manager.git /opt/server-manager
cd /opt/server-manager
npm ci
cp .env.example .env
openssl rand -base64 32
sudo npm run build
sudo npm run migrate
sudo -u server-manager ADMIN_USERNAME=admin ADMIN_PASSWORD='use-a-unique-16-char-password' npm run create-admin
sudo cp systemd/server-manager-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now server-manager-agent server-manager-api
sudo systemctl status server-manager-api --no-pager
```

The Host Agent socket is `/run/server-manager/agent.sock`, mode `0660`; place the API user in the agent group if your deployment uses a distinct group. Configure a narrow `/etc/sudoers.d/server-manager-agent` from the example, validate with `sudo visudo -cf /etc/sudoers.d/server-manager-agent`, and never grant a shell.

## Docker API/frontend

The API image is intentionally not given `/var/run/docker.sock`; it uses the native Host Agent socket. Build with `docker compose build`, validate with `docker compose config`, then `docker compose up -d`. Mount the socket only from the native agent and restrict access to the socket group.

## Reverse proxy and TLS

Copy `nginx/server-manager.conf.example` to `/etc/nginx/sites-available/server-manager`, set the real domain, link it into `sites-enabled`, run `sudo nginx -t`, reload only after confirmation, and use Certbot or an existing managed certificate. Health checks validate hostname/SAN, chain authorization, expiry, and latency where the target allows it.

## Controlled Node deployment

The `deploy_node_app` tool accepts only an exact application directory, PM2 name, domain, port, and Certbot email. Before using it, add the exact values to the Host Agent environment, for example:

```dotenv
DEPLOYMENT_PATH_ALLOWLIST=/var/www/vhosts/laon-demo
DEPLOYMENT_DOMAIN_ALLOWLIST=loan-demo.nickwebproject.com
PM2_ALLOWLIST=loan-demo
```

The request must include the application's local port and the email to register with Let's Encrypt. Sentinel shows one confirmation containing the exact path, PM2 name, domain, and port. The installed Host Agent service must have the minimum OS permissions for the fixed PM2, Nginx, symlink, and Certbot operations; these permissions are intentionally not granted by a shell wildcard.
