#!/usr/bin/env bash
# =============================================================
# TRANSWORLD PORTFOLIO INTELLIGENCE — DEPLOYMENT SCRIPT
# Run this on your local machine (Mac/Linux/WSL)
# =============================================================
# Usage:
#   chmod +x deploy.sh
#   ./deploy.sh
# =============================================================

set -e  # Stop on any error

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
info() { echo -e "${BLUE}[→]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

echo ""
echo "============================================================"
echo "  TRANSWORLD PORTFOLIO INTELLIGENCE — SETUP"
echo "============================================================"
echo ""

# ---- Step 1: Check prerequisites ----
info "Checking prerequisites..."

command -v node >/dev/null 2>&1 || err "Node.js not found. Install from https://nodejs.org (v18+)"
command -v npm  >/dev/null 2>&1 || err "npm not found. Install Node.js from https://nodejs.org"
command -v git  >/dev/null 2>&1 || err "git not found. Install from https://git-scm.com"

NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VER" -lt 18 ]; then
  err "Node.js v18+ required. You have $(node -v). Upgrade at https://nodejs.org"
fi

log "Node $(node -v) ✓"
log "npm $(npm -v) ✓"
log "git $(git --version | awk '{print $3}') ✓"

# ---- Step 2: Install dependencies ----
echo ""
info "Installing dependencies (this takes ~60 seconds)..."
npm install

log "Dependencies installed ✓"

# ---- Step 3: Check for .env.local ----
echo ""
if [ ! -f ".env.local" ]; then
  warn ".env.local not found — copying from .env.example"
  cp .env.example .env.local
  echo ""
  echo "  ┌─────────────────────────────────────────────────────┐"
  echo "  │  ACTION REQUIRED: Fill in your API keys             │"
  echo "  │                                                     │"
  echo "  │  Open .env.local in your editor and set:           │"
  echo "  │                                                     │"
  echo "  │  NEXT_PUBLIC_SUPABASE_URL=...                       │"
  echo "  │  NEXT_PUBLIC_SUPABASE_ANON_KEY=...                  │"
  echo "  │  SUPABASE_SERVICE_ROLE_KEY=...                      │"
  echo "  │  ANTHROPIC_API_KEY=...                              │"
  echo "  │  APIFY_API_KEY=...                                  │"
  echo "  │                                                     │"
  echo "  │  See SETUP_GUIDE.md for where to get each key.     │"
  echo "  └─────────────────────────────────────────────────────┘"
  echo ""
  read -p "  Press ENTER once you've filled in .env.local to continue..."
else
  log ".env.local found ✓"
fi

# ---- Step 4: Validate env vars ----
echo ""
info "Validating environment variables..."

source .env.local 2>/dev/null || true

MISSING=0
check_var() {
  if [ -z "${!1}" ] || [ "${!1}" = "$2" ]; then
    warn "Missing: $1"
    MISSING=$((MISSING+1))
  else
    log "$1 is set ✓"
  fi
}

check_var "NEXT_PUBLIC_SUPABASE_URL"      "https://YOUR_PROJECT_ID.supabase.co"
check_var "NEXT_PUBLIC_SUPABASE_ANON_KEY" "your_supabase_anon_key_here"
check_var "SUPABASE_SERVICE_ROLE_KEY"     "your_supabase_service_role_key_here"
check_var "ANTHROPIC_API_KEY"             "sk-ant-api03-your_key_here"

if [ "$MISSING" -gt 0 ]; then
  echo ""
  warn "$MISSING required variable(s) not set. The app will start but some features won't work."
  warn "Edit .env.local and run this script again, or configure in Vercel dashboard."
fi

# ---- Step 5: Build check ----
echo ""
info "Running build check..."
npm run build && log "Build successful ✓" || err "Build failed. Check errors above."

# ---- Step 6: Done ----
echo ""
echo "============================================================"
echo -e "  ${GREEN}SETUP COMPLETE!${NC}"
echo "============================================================"
echo ""
echo "  Next steps:"
echo ""
echo "  1. Run locally:       npm run dev"
echo "     Then open:         http://localhost:3000"
echo ""
echo "  2. Deploy to Vercel:  Run ./deploy-vercel.sh"
echo "     Or manually:       vercel --prod"
echo ""
echo "  3. Set up Supabase DB: See SETUP_GUIDE.md → Step 1"
echo ""
