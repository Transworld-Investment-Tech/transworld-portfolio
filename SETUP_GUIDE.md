# TRANSWORLD PORTFOLIO INTELLIGENCE
## Complete Setup Guide — Every Command You Need

---

## WHAT YOU NEED BEFORE STARTING

| Tool | Minimum version | Check with | Install |
|---|---|---|---|
| Node.js | v18+ | `node -v` | https://nodejs.org |
| npm | v9+ | `npm -v` | comes with Node |
| Git | any | `git --version` | https://git-scm.com |
| A terminal | — | — | Terminal (Mac), PowerShell/WSL (Windows) |

---

## STEP 0 — UNZIP AND ENTER THE PROJECT

```bash
# Unzip the downloaded file
unzip transworld-portfolio-app-v2.zip

# Enter the project folder
cd transworld-app

# Confirm you're in the right place (you should see package.json)
ls
```

---

## STEP 1 — SET UP SUPABASE (your database — free)

### 1a. Create a Supabase project

1. Go to **https://supabase.com** → click "Start your project"
2. Sign up / log in with GitHub
3. Click **New project**
4. Fill in:
   - **Name:** `transworld-portfolio`
   - **Database password:** choose a strong password and save it
   - **Region:** choose the closest to Lagos (London or Frankfurt are good options)
5. Click **Create new project** — wait ~2 minutes for it to spin up

### 1b. Run the database schema

1. In your Supabase project, click **SQL Editor** (left sidebar)
2. Click **New query**
3. Open `supabase_schema.sql` from the project folder in any text editor
4. Copy the **entire contents** and paste into the SQL editor
5. Click **Run** (or press `Ctrl+Enter` / `Cmd+Enter`)
6. You should see: `Success. No rows returned`

### 1c. Get your API keys

1. In Supabase, go to **Project Settings → API** (gear icon in left sidebar)
2. Copy these three values — you'll need them shortly:
   - **Project URL** → this is your `NEXT_PUBLIC_SUPABASE_URL`
   - **anon / public** key → this is your `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **service_role / secret** key → this is your `SUPABASE_SERVICE_ROLE_KEY`

---

## STEP 2 — GET YOUR ANTHROPIC API KEY (for AI reports)

```
1. Go to https://console.anthropic.com
2. Sign up or log in
3. Click "API Keys" in the left sidebar
4. Click "+ Create Key"
5. Name it: transworld-portfolio
6. Copy the key — it starts with: sk-ant-api03-...
   (You will NOT be able to see it again after closing the dialog)
```

> 💡 **Cost:** ~$0.05–0.15 per AI report generated. Add a billing card and set a monthly limit (e.g. $50) so you never get surprised.

---

## STEP 3 — GET YOUR APIFY API KEY (for live NGX prices)

```
1. Go to https://console.apify.com
2. Sign up (free tier is fine to start)
3. Click your profile icon (top right) → Settings
4. Click "Integrations"
5. Copy your "Personal API token" — it starts with: apify_api_...
```

> 💡 **Cost:** Free tier gives you $5/month credit, which covers daily NGX price refreshes for 6 stocks.

---

## STEP 4 — CONFIGURE YOUR ENVIRONMENT FILE

```bash
# Copy the example env file
cp .env.example .env.local

# Open it in your editor
# On Mac:
open -e .env.local

# On Linux/WSL:
nano .env.local
# or: code .env.local  (if you have VS Code)
```

Fill in your values — the file should look like this:

```
NEXT_PUBLIC_SUPABASE_URL=https://abcdefghij.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5c...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5c...
ANTHROPIC_API_KEY=sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXX
APIFY_API_KEY=apify_api_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_FIRM_NAME=Transworld Asset Management
NEXT_PUBLIC_FIRM_SHORT=Transworld AM
```

Save and close the file.

---

## STEP 5 — INSTALL AND RUN LOCALLY

```bash
# Install all dependencies (~60 seconds)
npm install

# Start the development server
npm run dev
```

You should see:
```
▲ Next.js 15.1.0
- Local: http://localhost:3000
- Ready in 2.3s
```

Open **http://localhost:3000** in your browser.

**First thing to do:**
1. Go to **Admin → Add client**
2. Create: Name = `Transworld Asset Management`, Code = `TWI`, Type = `Internal`
3. Then **Add portfolio → Label A**, NAV = `300000000`, tick "Seed default holdings"
4. Go to **Admin → Settings** → paste your Apify key → click Test

---

## STEP 6 — ADD YOUR FIRST USER (login account)

Supabase handles authentication. To create your login:

```bash
# Option A — via Supabase dashboard
# 1. Go to your Supabase project
# 2. Click Authentication (left sidebar)
# 3. Click "Add user"
# 4. Enter your email and a password
# 5. Click "Create user"
```

Or do it via the terminal with a quick script:

```bash
# Replace with your actual values
SUPABASE_URL="https://YOUR_PROJECT_ID.supabase.co"
SUPABASE_KEY="your_anon_key_here"
EMAIL="you@transworldam.com"
PASSWORD="YourStrongPassword123!"

curl -X POST "${SUPABASE_URL}/auth/v1/signup" \
  -H "apikey: ${SUPABASE_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}"
```

---

## STEP 7 — DEPLOY TO VERCEL (go live on the internet)

### 7a. Install Vercel CLI and log in

```bash
# Install Vercel CLI globally
npm install -g vercel

# Log in to Vercel (opens your browser)
vercel login
```

### 7b. Push to GitHub first (recommended)

```bash
# Initialise git
git init
git add .
git commit -m "Initial commit — Transworld Portfolio Intelligence"

# Create a new repo on GitHub at https://github.com/new
# Name it: transworld-portfolio
# Keep it PRIVATE (important — .env.local is gitignored but be careful)

# Connect and push (replace YOUR_USERNAME)
git remote add origin https://github.com/YOUR_USERNAME/transworld-portfolio.git
git branch -M main
git push -u origin main
```

### 7c. Deploy via Vercel dashboard (easiest)

```
1. Go to https://vercel.com/dashboard
2. Click "Add New → Project"
3. Click "Import" next to your transworld-portfolio repo
4. Framework: Next.js (auto-detected)
5. Click "Deploy" — it builds in ~2 minutes
```

### 7d. Add environment variables to Vercel

```
1. In Vercel dashboard → your project → Settings → Environment Variables
2. Add each variable from your .env.local file:

   Name                          Value
   ─────────────────────────────────────────────────────────
   NEXT_PUBLIC_SUPABASE_URL      https://xxx.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY eyJhbG...
   SUPABASE_SERVICE_ROLE_KEY     eyJhbG...
   ANTHROPIC_API_KEY             sk-ant-api03-...
   APIFY_API_KEY                 apify_api_...
   NEXT_PUBLIC_APP_URL           https://your-app.vercel.app
   NEXT_PUBLIC_FIRM_NAME         Transworld Asset Management
   NEXT_PUBLIC_FIRM_SHORT        Transworld AM

3. Set Environment: Production, Preview, Development (tick all three)
4. Click Save for each one
```

### 7e. Redeploy with the new env vars

```bash
# From your project folder:
vercel --prod
```

Or in Vercel dashboard → Deployments → click the three dots → Redeploy.

---

## STEP 8 — CUSTOM DOMAIN (optional but professional)

```
1. In Vercel dashboard → your project → Settings → Domains
2. Click "Add Domain"
3. Enter: portfolio.transworldam.com (or whatever you prefer)
4. Vercel gives you DNS records to add at your domain registrar
5. Add the CNAME record at your registrar (GoDaddy/Namecheap/etc)
6. Wait 10–60 min for DNS to propagate
7. Vercel auto-provisions an SSL certificate
```

Update your env var when done:
```
NEXT_PUBLIC_APP_URL=https://portfolio.transworldam.com
```

---

## QUICK REFERENCE — COMMANDS YOU'LL USE REGULARLY

```bash
# Start local development server
npm run dev

# Check for TypeScript errors without building
npm run lint

# Build for production (Vercel does this automatically)
npm run build

# Deploy to production on Vercel
vercel --prod

# Deploy a preview (for testing before going live)
vercel

# View Vercel logs (live)
vercel logs your-app-name --follow

# Pull environment variables from Vercel to local
vercel env pull .env.local
```

---

## TROUBLESHOOTING

### "Cannot find module" or TypeScript errors
```bash
rm -rf node_modules .next
npm install
npm run dev
```

### Supabase connection error
```bash
# Check your .env.local values are correct
cat .env.local | grep SUPABASE

# Test the connection
curl "https://YOUR_PROJECT_ID.supabase.co/rest/v1/clients" \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Authorization: Bearer YOUR_ANON_KEY"
# Should return [] (empty array) if schema is set up
```

### Apify returns no data
```bash
# Test your key directly
curl -X POST \
  "https://api.apify.com/v2/acts/apify~trading-view-scraper/run-sync-get-dataset-items?token=YOUR_APIFY_KEY&timeout=60" \
  -H "Content-Type: application/json" \
  -d '{"symbols":["NGX:UBA"],"timeframe":"D","bars":1}'
# Should return a JSON array with price data
```

### AI reports fail
```bash
# Test your Anthropic key
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: YOUR_ANTHROPIC_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":10,"messages":[{"role":"user","content":"Hi"}]}'
# Should return a short message response
```

### Build fails on Vercel
```bash
# Check the build locally first — this shows the exact same errors as Vercel
npm run build
```

---

## UPDATING THE APP IN THE FUTURE

```bash
# Make your changes locally
# Test with npm run dev

# Commit and push
git add .
git commit -m "describe what you changed"
git push

# Vercel auto-deploys on every push to main
# (if you connected via GitHub — recommended)

# Or deploy manually:
vercel --prod
```

---

## NEED HELP?

- Supabase docs: https://supabase.com/docs
- Next.js docs: https://nextjs.org/docs
- Vercel docs: https://vercel.com/docs
- Anthropic API: https://docs.anthropic.com
- Apify TradingView scraper: https://apify.com/apify/trading-view-scraper
