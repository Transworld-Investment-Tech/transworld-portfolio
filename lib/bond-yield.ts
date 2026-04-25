// lib/bond-yield.ts
// v22:  Bond yield-to-maturity computation.
// v25:  Modified duration and convexity added to YieldResult; new
//       computeDurationConvexity helper for instruments where the yield is
//       already known (so we don't re-solve when displaying duration on
//       the FI table or curve tooltip).
//
// Given a clean price, coupon rate, maturity date, and settlement date, solve
// for the YTM that makes the present value of future cash flows equal to the
// clean price. Uses Brent's method over y ∈ (-50%, 200%).
//
// Conventions:
//   - Face value = 100 (NGX convention)
//   - Bond coupons: semi-annual (freq=2)
//   - Commercial paper: treated as zero-coupon with freq=2 (semi-annual
//     compounding convention, matching standard FI quote basis)
//   - Day count: actual / 365.25 for period calculation
//
// Known limitations:
//   - This is the standard "street" YTM, not a day-count-adjusted yield.
//     It's accurate to ±0.2% for any bond with > 6 months to maturity, which
//     covers every instrument in our watchlist. For near-maturity bonds
//     (< 3 months), yields can look extreme — we flag these for review rather
//     than silently trust them.
//   - Assumes coupon payments align with a date grid derived from maturity;
//     ignores accrued interest (we use clean price, matching how NGX quotes).

export interface YieldResult {
  ytm_pct: number          // annualized, as a percent (e.g. 15.60)
  flag: YieldFlag | null   // non-null if the result looks suspicious
  periods: number          // periods to maturity used in the calc
  days_to_maturity: number
  mod_duration: number     // v25 — modified duration in years (sensitivity)
  convexity: number        // v25 — convexity in years² (curvature)
}

export type YieldFlag =
  | 'matured'              // settlement date is at or past maturity
  | 'par-at-or-above'      // zero-coupon priced at face or above — no yield signal
  | 'extreme-high'         // YTM > 50% — price likely stale or forced trade
  | 'extreme-low'          // YTM < 5% — unusual for Nigerian FI, price may be stale
  | 'solver-failed'        // numerical solver could not converge

/**
 * Brent's method root-finder.
 */
function brentq(
  f: (x: number) => number,
  a: number,
  b: number,
  tol = 1e-8,
  maxIter = 100,
): number | null {
  let fa = f(a)
  let fb = f(b)
  if (!isFinite(fa) || !isFinite(fb)) return null
  if (fa * fb > 0) return null

  if (Math.abs(fa) < Math.abs(fb)) {
    [a, b] = [b, a]
    ;[fa, fb] = [fb, fa]
  }

  let c = a
  let fc = fa
  let mflag = true
  let s = b
  let d = 0

  for (let i = 0; i < maxIter; i++) {
    if (Math.abs(fb) < tol) return b
    if (Math.abs(b - a) < tol) return b

    if (fa !== fc && fb !== fc) {
      s = (a * fb * fc) / ((fa - fb) * (fa - fc)) +
          (b * fa * fc) / ((fb - fa) * (fb - fc)) +
          (c * fa * fb) / ((fc - fa) * (fc - fb))
    } else {
      s = b - fb * (b - a) / (fb - fa)
    }

    const cond1 = !((s - (3 * a + b) / 4) * (s - b) < 0)
    const cond2 = mflag && Math.abs(s - b) >= Math.abs(b - c) / 2
    const cond3 = !mflag && Math.abs(s - b) >= Math.abs(c - d) / 2
    const cond4 = mflag && Math.abs(b - c) < tol
    const cond5 = !mflag && Math.abs(c - d) < tol

    if (cond1 || cond2 || cond3 || cond4 || cond5) {
      s = (a + b) / 2
      mflag = true
    } else {
      mflag = false
    }

    const fs = f(s)
    d = c
    c = b
    fc = fb

    if (fa * fs < 0) {
      b = s
      fb = fs
    } else {
      a = s
      fa = fs
    }

    if (Math.abs(fa) < Math.abs(fb)) {
      [a, b] = [b, a]
      ;[fa, fb] = [fb, fa]
    }
  }

  return b
}

function parseDate(iso: string): Date {
  const d = new Date(iso + 'T00:00:00Z')
  if (isNaN(d.getTime())) throw new Error(`Invalid date: ${iso}`)
  return d
}

/**
 * v25: Compute modified duration and convexity from an already-known yield.
 * Called by the FI table and curve panel where we don't need to re-solve YTM.
 *
 * Modified duration: percentage price change per 100bps yield change.
 *   ModDuration = -1/Price * dPrice/dy = MacaulayDuration / (1 + y/freq)
 *
 * Convexity: second-order curvature.
 *   Convexity = (1/Price) * d²Price/dy²
 *
 * Returns null if inputs are invalid or bond is matured.
 */
export function computeDurationConvexity(
  ytmPct: number,
  couponPct: number,
  maturityDateIso: string,
  settlementDateIso: string,
  freq = 2,
): { mod_duration: number; convexity: number } | null {
  if (!isFinite(ytmPct) || ytmPct <= -90) return null
  if (!isFinite(couponPct) || couponPct < 0) return null

  let mat: Date, set: Date
  try {
    mat = parseDate(maturityDateIso)
    set = parseDate(settlementDateIso)
  } catch {
    return null
  }

  const daysToMaturity = Math.round((mat.getTime() - set.getTime()) / 86_400_000)
  if (daysToMaturity <= 0) return null

  const face = 100
  const years = daysToMaturity / 365.25
  const nPeriods = Math.max(1, Math.round(years * freq))
  const periodicCoupon = (couponPct / 100 * face) / freq

  const y = ytmPct / 100
  const r = y / freq
  if (r <= -1) return null

  let pvSum = 0
  let weightedT = 0   // Σ t · PV(CF_t), where t is in years
  let convexSum = 0   // Σ k(k+1) · PV(CF_t) / (1+r)²

  for (let k = 1; k <= nPeriods; k++) {
    const t = k / freq
    const cf = (k === nPeriods) ? periodicCoupon + face : periodicCoupon
    const pvCF = cf / Math.pow(1 + r, k)
    pvSum    += pvCF
    weightedT += t * pvCF
    convexSum += k * (k + 1) * pvCF / Math.pow(1 + r, 2)
  }

  if (pvSum <= 0) return null

  const macaulay = weightedT / pvSum                       // years
  const modDuration = macaulay / (1 + r)                   // years
  const convexity = convexSum / (pvSum * freq * freq)      // years²

  return { mod_duration: modDuration, convexity }
}

/**
 * Compute YTM. Returns null if inputs are invalid.
 * v25: now also returns mod_duration and convexity (computed from solved y).
 */
export function computeBondYTM(
  cleanPrice: number,
  couponPct: number,
  maturityDateIso: string,
  settlementDateIso: string,
  freq = 2,
): YieldResult | null {
  if (!isFinite(cleanPrice) || cleanPrice <= 0) return null
  if (!isFinite(couponPct) || couponPct < 0) return null

  let mat: Date, set: Date
  try {
    mat = parseDate(maturityDateIso)
    set = parseDate(settlementDateIso)
  } catch {
    return null
  }

  const daysToMaturity = Math.round((mat.getTime() - set.getTime()) / 86_400_000)
  if (daysToMaturity <= 0) {
    return {
      ytm_pct: 0, flag: 'matured', periods: 0, days_to_maturity: daysToMaturity,
      mod_duration: 0, convexity: 0,
    }
  }

  const face = 100
  const years = daysToMaturity / 365.25
  const nPeriods = Math.max(1, Math.round(years * freq))
  const periodicCoupon = (couponPct / 100 * face) / freq

  // Zero-coupon at par-or-above: no yield signal, no duration/convexity meaning.
  if (periodicCoupon === 0 && cleanPrice >= face) {
    return {
      ytm_pct: 0, flag: 'par-at-or-above', periods: nPeriods, days_to_maturity: daysToMaturity,
      mod_duration: 0, convexity: 0,
    }
  }

  const pv = (yi: number): number => {
    if (yi <= -0.9) return Infinity
    const ri = yi / freq
    let total = 0
    for (let k = 1; k <= nPeriods; k++) {
      total += periodicCoupon / Math.pow(1 + ri, k)
    }
    total += face / Math.pow(1 + ri, nPeriods)
    return total
  }

  const f = (yi: number) => pv(yi) - cleanPrice

  const ySolved = brentq(f, -0.5, 2.0)
  if (ySolved === null) {
    return {
      ytm_pct: NaN, flag: 'solver-failed', periods: nPeriods, days_to_maturity: daysToMaturity,
      mod_duration: NaN, convexity: NaN,
    }
  }

  const ytmPct = ySolved * 100
  let flag: YieldFlag | null = null
  if (ytmPct > 50) flag = 'extreme-high'
  else if (ytmPct < 5) flag = 'extreme-low'

  // Compute duration / convexity from the solved yield, reusing the cashflow grid.
  const r = ySolved / freq
  let pvSum = 0
  let weightedT = 0
  let convexSum = 0
  for (let k = 1; k <= nPeriods; k++) {
    const t = k / freq
    const cf = (k === nPeriods) ? periodicCoupon + face : periodicCoupon
    const pvCF = cf / Math.pow(1 + r, k)
    pvSum     += pvCF
    weightedT += t * pvCF
    convexSum += k * (k + 1) * pvCF / Math.pow(1 + r, 2)
  }
  const macaulay    = pvSum > 0 ? weightedT / pvSum                 : 0
  const modDuration = pvSum > 0 ? macaulay / (1 + r)                : 0
  const convexity   = pvSum > 0 ? convexSum / (pvSum * freq * freq) : 0

  return {
    ytm_pct: ytmPct,
    flag,
    periods: nPeriods,
    days_to_maturity: daysToMaturity,
    mod_duration: modDuration,
    convexity,
  }
}

export function explainFlag(flag: YieldFlag): string {
  switch (flag) {
    case 'matured':         return 'Bond has matured — no yield to compute'
    case 'par-at-or-above': return 'Zero-coupon at or above par — no yield signal from price'
    case 'extreme-high':    return 'Yield > 50% — clean price is likely stale or reflects a thin/forced trade'
    case 'extreme-low':     return 'Yield < 5% — unusually low for Nigerian FI; price may be stale'
    case 'solver-failed':   return 'Numerical solver failed to converge'
  }
}
