#!/usr/bin/env bash
# =============================================================
# TRANSWORLD — DEPLOY TO VERCEL
# Run after setup.sh has completed successfully
# =============================================================

set -e

GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[✓]${NC} $1"; }
info() { echo -e "${BLUE}[→]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

echo ""
echo "============================================================"
echo "  TRANSWORLD — DEPLOY TO VERCEL"
echo "============================================================"
echo ""

# ---- Install Vercel CLI if needed ----
if ! command -v vercel &>/dev/null; then
  info "Installing Vercel CLI..."
  npm install -g vercel
  log "Vercel CLI installed ✓"
else
  log "Vercel CLI $(vercel --version) already installed ✓"
fi

# ---- Init git repo if needed ----
if [ ! -d ".git" ]; then
  info "Initialising git repository..."
  git init
  git add .
  git commit -m "Initial commit — Transworld Portfolio Intelligence"
  log "Git repo initialised ✓"
else
  log "Git repo already exists ✓"
fi

# ---- Deploy ----
echo ""
info "Deploying to Vercel..."
echo ""
warn "You will be prompted to:"
echo "  1. Log in to Vercel (opens browser)"
echo "  2. Confirm project name (press Enter to accept default)"
echo "  3. Confirm it's a Next.js project (press Enter)"
echo ""
read -p "Press ENTER to start deployment..."

vercel

echo ""
echo "============================================================"
echo -e "  ${GREEN}DEPLOYED!${NC}"
echo "============================================================"
echo ""
echo "  IMPORTANT: Add your environment variables to Vercel now:"
echo ""
echo "  Option A — Vercel Dashboard (recommended):"
echo "    1. Go to https://vercel.com/dashboard"
echo "    2. Click your project → Settings → Environment Variables"
echo "    3. Add all variables from .env.local"
echo "    4. Redeploy: vercel --prod"
echo ""
echo "  Option B — CLI (run these one by one):"
echo "    vercel env add NEXT_PUBLIC_SUPABASE_URL"
echo "    vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY"
echo "    vercel env add SUPABASE_SERVICE_ROLE_KEY"
echo "    vercel env add ANTHROPIC_API_KEY"
echo "    vercel env add APIFY_API_KEY"
echo "    vercel --prod"
echo ""
