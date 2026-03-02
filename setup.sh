#!/bin/bash
# ═══════════════════════════════════════════════════════
# LUMA — One-command setup script
# Run this ONCE after filling in .env.secrets
# Prerequisites: gh CLI installed (cli.github.com)
# ═══════════════════════════════════════════════════════

set -e

# ── Config — change YOUR_GITHUB_USERNAME and YOUR_REPO_NAME ──
GITHUB_REPO="YOUR_GITHUB_USERNAME/YOUR_REPO_NAME"
# Example: GITHUB_REPO="shreevathsbbhh/zodiac"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  LUMA Setup — Uploading all secrets"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Check gh CLI is installed
if ! command -v gh &> /dev/null; then
  echo "❌  GitHub CLI (gh) not found."
  echo "    Install from: https://cli.github.com"
  echo "    Then run: gh auth login"
  exit 1
fi

# Check .env.secrets exists
if [ ! -f ".env.secrets" ]; then
  echo "❌  .env.secrets file not found in current directory"
  exit 1
fi

# Check no placeholder values remain
if grep -q "PASTE_YOUR" .env.secrets; then
  echo "❌  You still have unfilled values in .env.secrets"
  echo "    Fill in R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, CF_KV_API_TOKEN"
  exit 1
fi

echo ""
echo "📤  Uploading GitHub Secrets to: $GITHUB_REPO"
# Upload all secrets from .env.secrets (skips comment lines automatically)
gh secret set --env-file .env.secrets --repo "$GITHUB_REPO"

echo ""
echo "✅  All GitHub Secrets uploaded!"
echo ""
echo "📋  Verifying secrets list:"
gh secret list --repo "$GITHUB_REPO"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  NEXT STEPS (manual — 2 minutes)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "1. Go to Cloudflare Pages → your project → Settings → Environment Variables"
echo "   Add these 3 variables:"
echo ""
echo "   GITHUB_TOKEN  = (your GitHub Personal Access Token — repo scope)"
echo "   GITHUB_REPO   = $GITHUB_REPO"
echo "   KAGGLE_DATASET= shreevathsbbhh/video-clips"
echo ""
echo "2. Push all files to GitHub:"
echo "   git add ."
echo "   git commit -m 'Add video generator'"
echo "   git push"
echo ""
echo "3. DELETE this .env.secrets file now:"
echo "   rm .env.secrets"
echo ""
echo "Done! 🎬"
