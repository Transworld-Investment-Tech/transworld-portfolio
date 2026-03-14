# Transworld Portfolio Intelligence Platform

> Multi-portfolio management & AI-powered reporting for Transworld Asset Management
> Supports up to 25 client portfolios (Portfolio A–D per client)

---

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js 15** (App Router) | Full-stack, API routes + React UI in one project |
| Database | **Supabase** (PostgreSQL) | Auth, real-time, row-level security, free tier available |
| AI Reports | **Anthropic Claude** (claude-sonnet-4) + web search | Live market research + report generation |
| Market Data | **Apify** (TradingView scraper) | Live NGX equity prices |
| Hosting | **Vercel** | Zero-config deployment, scales automatically |
| Styling | **Tailwind CSS** | Fast, consistent dark-mode UI |

---

## Project Structure

```
transworld-app/
├── app/
│   ├── page.tsx                    # Home — portfolio selector (all clients)
│   ├── portfolio/[id]/page.tsx     # Individual portfolio dashboard
│   ├── admin/                      # Admin pages (clients, settings)
│   └── api/
│       ├── portfolios/route.ts     # CRUD portfolios
│       ├── prices/route.ts         # Refresh live market prices (Apify)
│       ├── reports/route.ts        # Generate + save AI reports
│       ├── holdings/route.ts       # Manage holdings
│       └── transactions/route.ts   # Trade entry
├── components/
│   └── portfolio/
│       ├── AllocationDonut.tsx     # Chart.js donut chart
│       ├── SleeveBarChart.tsx      # Sleeve progress bars
│       └── IncomeChart.tsx         # 12-month income projection
├── lib/
│   ├── supabase.ts                 # Supabase client
│   ├── portfolio.ts                # NAV, sleeve, compliance calculations
│   ├── market-data.ts              # Apify + Alpha Vantage fetchers
│   └── report-engine.ts            # Claude AI report generation
├── supabase_schema.sql             # Full database schema (run this first)
└── .env.example                    # Environment variables template
```

---

## Deployment Guide (Step by Step)

### Step 1 — Supabase (Database)

1. Go to [supabase.com](https://supabase.com) → New project
2. Name it `transworld-portfolio`
3. Once created, go to **SQL Editor** → paste the entire contents of `supabase_schema.sql` → Run
4. Go to **Project Settings → API** and copy:
   - `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`

### Step 2 — Anthropic API Key

1. Go to [console.anthropic.com](https://console.anthropic.com) → API Keys → Create key
2. Copy the key → `ANTHROPIC_API_KEY`
3. Recommended model tier: **Claude Sonnet** (best cost/quality ratio for reports)
4. Estimated cost: ~$0.05–0.15 per report generated (with web search)

### Step 3 — Apify API Key

1. Go to [console.apify.com](https://console.apify.com) → Sign up (free tier works)
2. Settings → Integrations → copy API token → `APIFY_API_KEY`
3. The app uses actor: `apify~trading-view-scraper`
4. NGX symbols: `NGX:UBA`, `NGX:GTCO`, `NGX:ZENITHBANK`, `NGX:DANGCEM`, `NGX:STANBIC`, `NGX:SEPLAT`

### Step 4 — Deploy to Vercel

```bash
# Install Vercel CLI
npm i -g vercel

# In the project folder:
cp .env.example .env.local
# Fill in all values in .env.local

npm install
npm run dev          # Test locally first

# Deploy to production:
vercel
# Follow prompts — link to your Vercel account
# Add all environment variables in Vercel dashboard → Settings → Environment Variables
```

Or use the Vercel dashboard:
1. Push this folder to a GitHub repo
2. Go to [vercel.com](https://vercel.com) → New Project → Import from GitHub
3. Add all env variables from `.env.example`
4. Deploy

### Step 5 — First-time Setup in the App

1. Open your deployed app URL
2. Click **Admin → Add client** → Add "Transworld Asset Management" as first client (type: internal)
3. Click **Add portfolio** → Label: A, Name: "Transworld Portfolio A", NAV: ₦300,000,000, check "Seed default holdings"
4. Go to **Admin → Settings** → enter your Apify key → Save
5. Click **Live prices** on any portfolio dashboard to pull current NGX prices
6. Click **Generate AI report** to test the report engine

---

## Adding New Clients & Portfolios

- From the home page, click **Add client**
- Fill in client name, code (e.g. "CLIENT_B"), type (discretionary/advisory/internal)
- Then click **Add portfolio** next to the client to create Portfolio A, B, C, D etc.
- Each portfolio has its own sleeve targets, holdings, NAV log, and report history
- Maximum: **25 portfolios** (adjustable in `/app/api/portfolios/route.ts`)

---

## Market Data Sources

| Source | Data | Cost | Notes |
|---|---|---|---|
| Apify (TradingView) | NGX equity prices | ~$0.01/run, free tier | Primary for equities |
| Alpha Vantage | NGX equities via .LAG | Free (25 calls/day) | Fallback |
| exchangerate-api.com | USD/NGN FX rate | Free | Auto-fetched on load |
| FMDQ Group | NTB rates, bond yields | Manual / API on request | Enter via admin panel |
| CBN | MPR, monetary policy | Manual / scraping | Captured by AI report |
| NBS | Inflation, GDP | Manual | Captured by AI report |

---

## Scaling Beyond 25 Portfolios

Change the cap in `/app/api/portfolios/route.ts`:
```typescript
if ((count ?? 0) >= 25) { ... }  // Change 25 to desired limit
```

---

## Estimated Monthly Running Costs

| Service | Usage | Estimated Cost |
|---|---|---|
| Vercel (hosting) | Hobby/Pro plan | $0–$20/mo |
| Supabase | Free tier covers small-medium load | $0–$25/mo |
| Anthropic API | ~2 reports/portfolio/week × 25 portfolios | $15–$50/mo |
| Apify | Daily price refresh × 6 stocks | $5–$15/mo |
| **Total** | | **~$20–$110/mo** |

---

## Security Notes

- ⚠️ Never commit `.env.local` to git (it's in `.gitignore`)
- The `SUPABASE_SERVICE_ROLE_KEY` bypasses RLS — only used server-side in API routes
- Add proper authentication (Supabase Auth) before sharing the URL externally
- Consider adding IP allowlisting in Supabase for production
