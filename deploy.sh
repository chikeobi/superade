#!/usr/bin/env bash
# deploy.sh — push engine changes to VPS and restart PM2
set -e

VPS="root@187.77.192.9"
REMOTE="/root/superade/engine"
LOCAL="$(cd "$(dirname "$0")/engine" && pwd)"
KEY="$HOME/.ssh/superade_deploy"

scp_via() { scp -i "$KEY" "$@"; }
ssh_via()  { ssh -i "$KEY" "$VPS" "$@"; }

echo "==> Uploading updated files..."
scp_via "$LOCAL/api/onboarding.js"  "$VPS:$REMOTE/api/"
scp_via "$LOCAL/api/admin.js"       "$VPS:$REMOTE/api/"
scp_via "$LOCAL/api/server.js"      "$VPS:$REMOTE/api/"
scp_via "$LOCAL/agents/watchdog.js" "$VPS:$REMOTE/agents/"

echo "==> Writing env vars (removing old values first to avoid duplicates)..."
ssh_via "
  sed -i '/^STRIPE_PRICE_STARTER=/d;/^STRIPE_PRICE_GROWTH=/d;/^STRIPE_PRICE_SCALE=/d;/^ADMIN_PASSWORD=/d' $REMOTE/.env
  printf 'STRIPE_PRICE_STARTER=price_1TZKd7BsSQqPty2XqxBOBJLN\nSTRIPE_PRICE_GROWTH=price_1TZKdYBsSQqPty2Xg1dHvNCI\nSTRIPE_PRICE_SCALE=price_1TZKdpBsSQqPty2XVmzklJ1f\nADMIN_PASSWORD=5up3r@d3@g3nt\n' >> $REMOTE/.env
"

echo "==> Restarting PM2..."
ssh_via "pm2 restart all && pm2 save"

echo "==> Verifying PM2 status..."
ssh_via "pm2 list"

echo ""
echo "✓ Deploy complete."
echo "  Onboarding: http://187.77.192.9:3000/onboarding"
echo "  Admin:      http://187.77.192.9:3000/admin  (user: admin)"
