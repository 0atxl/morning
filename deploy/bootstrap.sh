#!/usr/bin/env bash
set -euo pipefail

# Run as the VM administrator. The only argument is a deploy PUBLIC key file.
if [[ $EUID != 0 || $# != 1 ]]; then
  echo 'Usage: sudo bash deploy/bootstrap.sh /path/to/deploy-key.pub' >&2
  exit 1
fi
morning_files=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
morning_public_key=$(cat -- "$1")
if [[ "$morning_public_key" == *$'\n'* || ! "$morning_public_key" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ .*)?$ ]]; then
  echo 'Expected one Ed25519 public key.' >&2
  exit 1
fi

if ! command -v nginx >/dev/null; then
  # Prevent the package's default public listener from starting.
  systemctl mask nginx.service
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nginx
fi
id morning >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin morning
id morning-deploy >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/morning-deploy --shell /bin/sh morning-deploy
install -d -m 0755 -o morning-deploy -g morning-deploy /opt/morning /opt/morning/releases
install -d -m 0750 -o root -g morning /etc/morning
if [[ ! -e /etc/morning/server.env ]]; then
  install -m 0640 -o root -g morning /dev/null /etc/morning/server.env
  cat > /etc/morning/server.env <<'ENV'
DEEPGRAM_API_KEY=
GROQ_API_KEY=
LISTEN_ADDR=127.0.0.1:8080
ENV
fi
chown root:morning /etc/morning/server.env
chmod 0640 /etc/morning/server.env
install -d -m 0755 /usr/local/libexec
install -m 0755 -o root -g root "$morning_files/receive.py" /usr/local/libexec/morning-receive
install -m 0644 -o root -g root "$morning_files/nginx.conf" /etc/morning/nginx.conf
install -m 0644 -o root -g root "$morning_files/morning-api.service" /etc/systemd/system/morning-api.service
install -m 0644 -o root -g root "$morning_files/morning-web.service" /etc/systemd/system/morning-web.service

install -d -m 0700 -o morning-deploy -g morning-deploy /var/lib/morning-deploy/.ssh
printf 'restrict,command="/usr/local/libexec/morning-receive" %s\n' "$morning_public_key" \
  > /var/lib/morning-deploy/.ssh/authorized_keys
chown morning-deploy:morning-deploy /var/lib/morning-deploy/.ssh/authorized_keys
chmod 0600 /var/lib/morning-deploy/.ssh/authorized_keys
printf '%s\n' 'morning-deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart morning-api.service' \
  > /etc/sudoers.d/morning-deploy
chmod 0440 /etc/sudoers.d/morning-deploy

systemctl daemon-reload
systemctl enable morning-api.service morning-web.service
systemctl restart morning-web.service
echo 'VM services installed. Fill /etc/morning/server.env on the VM before enabling deployments.'
