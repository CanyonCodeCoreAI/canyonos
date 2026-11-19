#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo 'Run this script with sudo.' >&2
  exit 1
fi

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
config_directory=/opt/sonarqube
secret_directory=/etc/sonarqube

: "${SONARQUBE_PUBLIC_IP:?Set SONARQUBE_PUBLIC_IP to the associated Elastic IP.}"

if [[ ! $SONARQUBE_PUBLIC_IP =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  echo 'SONARQUBE_PUBLIC_IP must be an IPv4 address.' >&2
  exit 1
fi

if [[ -e "$secret_directory/sonarqube.env" || -e "$config_directory/compose.yaml" ]]; then
  echo 'An existing SonarQube setup was found. Refusing to overwrite its database credentials.' >&2
  exit 1
fi

for required_command in docker openssl curl; do
  if ! command -v "$required_command" >/dev/null; then
    echo "Missing required command: $required_command" >&2
    exit 1
  fi
done

if ! docker compose version >/dev/null; then
  echo 'Docker Compose v2 is required.' >&2
  exit 1
fi

curl_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

curl_post() {
  local login password url data_argument
  login=$1
  password=$2
  url=$3
  shift 3
  {
    printf '%s\n' 'fail' 'silent' 'show-error' 'request = "POST"'
    printf 'user = "%s:%s"\n' "$(curl_escape "$login")" "$(curl_escape "$password")"
    for data_argument in "$@"; do
      printf 'data-urlencode = "%s"\n' "$(curl_escape "$data_argument")"
    done
    printf 'url = "%s"\n' "$(curl_escape "$url")"
  } | curl --config - >/dev/null
}

sonarqube_ready() {
  curl --fail --silent http://127.0.0.1:9000/api/system/status \
    | grep -Eq '"status"[[:space:]]*:[[:space:]]*"UP"'
}

write_https_nginx_config() {
  cat >/etc/nginx/sites-available/sonarqube <<'EOF'
server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name _;

    ssl_certificate /etc/letsencrypt/live/sonarqube-ip/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sonarqube-ip/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    # Scanner analysis reports are several MB; nginx's 1 MB default refuses them with 413.
    client_max_body_size 100m;

    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    location / {
        proxy_pass http://127.0.0.1:9000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_pass_header Sonar-MD5;
        proxy_pass_header SonarQube-Authentication-Token-Expiration;
    }
}
EOF
}

install_https_proxy() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y nginx
  systemctl disable --now nginx
  rm -f /etc/nginx/sites-enabled/default
  docker run --rm --network host \
    --volume /etc/letsencrypt:/etc/letsencrypt \
    --volume /var/lib/letsencrypt:/var/lib/letsencrypt \
    --volume /var/log/letsencrypt:/var/log/letsencrypt \
    certbot/certbot:v5.10.0 certonly --non-interactive --agree-tos \
    --email "$administrator_email" \
    --preferred-profile shortlived \
    --standalone \
    --ip-address "$SONARQUBE_PUBLIC_IP" \
    --cert-name sonarqube-ip

  write_https_nginx_config
  ln -s /etc/nginx/sites-available/sonarqube /etc/nginx/sites-enabled/sonarqube
  nginx -t
  systemctl enable --now nginx

  cat >/etc/systemd/system/sonarqube-certbot-renew.service <<'EOF'
[Unit]
Description=Renew the SonarQube Elastic IP certificate

[Service]
Type=oneshot
ExecStart=/usr/bin/docker run --rm --network host --volume /etc/letsencrypt:/etc/letsencrypt --volume /var/lib/letsencrypt:/var/lib/letsencrypt --volume /var/log/letsencrypt:/var/log/letsencrypt certbot/certbot:v5.10.0 renew --quiet --preferred-profile shortlived
ExecStartPost=/usr/sbin/nginx -s reload
EOF
  cat >/etc/systemd/system/sonarqube-certbot-renew.timer <<'EOF'
[Unit]
Description=Renew the SonarQube Elastic IP certificate twice daily

[Timer]
OnCalendar=*-*-* 00,12:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now sonarqube-certbot-renew.timer
}

read -r -p 'Initial SonarQube administrator login: ' administrator_login
read -r -p 'Initial SonarQube administrator name: ' administrator_name
read -r -p 'Initial SonarQube administrator email: ' administrator_email
read -r -s -p 'Initial SonarQube administrator password: ' administrator_password
printf '\n'
read -r -s -p 'Confirm administrator password: ' administrator_password_confirmation
printf '\n'

if [[ ! $administrator_login =~ ^[A-Za-z0-9._-]{2,255}$ ]]; then
  echo 'Administrator login must be 2 to 255 letters, digits, dots, underscores, or hyphens.' >&2
  exit 1
fi

if [[ $administrator_login == admin ]]; then
  echo 'Choose an administrator login other than admin.' >&2
  exit 1
fi

if [[ ! $administrator_email =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  echo "Administrator email must be a valid address for Let's Encrypt notifications." >&2
  exit 1
fi

if [[ ${#administrator_password} -lt 16 ]]; then
  echo 'Administrator password must contain at least 16 characters.' >&2
  exit 1
fi

if [[ $administrator_name == *$'\n'* || $administrator_name == *$'\r'* || $administrator_password == *$'\n'* || $administrator_password == *$'\r'* ]]; then
  echo 'Administrator name and password cannot contain line breaks.' >&2
  exit 1
fi

if [[ $administrator_password != "$administrator_password_confirmation" ]]; then
  echo 'Administrator passwords do not match.' >&2
  exit 1
fi

install -d -m 0700 "$secret_directory"
install -d -m 0750 "$config_directory"
install -m 0640 "$repository_root/.docker/sonarqube/compose.yaml" "$config_directory/compose.yaml"

umask 077
{
  printf 'SONARQUBE_POSTGRES_PASSWORD=%s\n' "$(openssl rand -base64 36 | tr -d '\n')"
  printf 'SONARQUBE_JWT_SECRET=%s\n' "$(openssl rand -base64 48 | tr -d '\n')"
} >"$secret_directory/sonarqube.env"

printf '%s\n' 'vm.max_map_count=524288' 'fs.file-max=131072' >/etc/sysctl.d/99-sonarqube.conf
sysctl --system >/dev/null

docker compose --env-file "$secret_directory/sonarqube.env" -f "$config_directory/compose.yaml" up -d

for _ in {1..90}; do
  if sonarqube_ready; then
    break
  fi
  sleep 2
done

if ! sonarqube_ready; then
  echo 'SonarQube did not become ready. Inspect: docker compose -f /opt/sonarqube/compose.yaml logs' >&2
  exit 1
fi

curl_post admin admin http://127.0.0.1:9000/api/users/change_password \
  previousPassword=admin "password=$administrator_password" login=admin

curl_post admin "$administrator_password" http://127.0.0.1:9000/api/users/create \
  "login=$administrator_login" "name=$administrator_name" "email=$administrator_email" "password=$administrator_password"

curl_post admin "$administrator_password" http://127.0.0.1:9000/api/permissions/add_user \
  "login=$administrator_login" permission=admin

curl_post "$administrator_login" "$administrator_password" http://127.0.0.1:9000/api/users/deactivate login=admin

install_https_proxy

curl_post "$administrator_login" "$administrator_password" http://127.0.0.1:9000/api/settings/set \
  key=sonar.core.serverBaseURL "value=https://$SONARQUBE_PUBLIC_IP"

unset administrator_password administrator_password_confirmation

echo "SonarQube is ready at https://$SONARQUBE_PUBLIC_IP."
