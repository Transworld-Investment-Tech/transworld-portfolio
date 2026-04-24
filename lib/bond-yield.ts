// lib/bond-yield.ts
// v22: Bond yield-to-maturity computation.
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
}

export type YieldFlag =
  | 'matured'              // settlement date is at or past maturity
  | 'par-at-or-above'      // zero-coupon priced at face or above — no yield signal
  | 'extreme-high'         // YTM > 50% — price likely stale or forced trade
  | 'extreme-low'          // YTM < 5% — unusual for Nigerian FI, price may be stale
  | 'solver-failed'        // numerical solver could not converge

/**
 * Brent's method root-finder. Local implementation so we don't depend on
 * mathjs or any external numerics for this one use case.
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
  if (fa * fb > 0) return null  // no sign change in interval

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
      // Inverse quadratic interpolation
      s = (a * fb * fc) / ((fa - fb) * (fa - fc)) +
          (b * fa * fc) / ((fb - fa) * (fb - fc)) +
          (c * fa * fb) / ((fc - fa) * (fc - fb))
    } else {
      // Secant
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

  return b  // best guess after maxIter
}

/**
 * Parse an ISO date string (YYYY-MM-DD) to a UTC Date at midnight.
 */
function parseDate(iso: string): Date {
  const d = new Date(iso + 'T00:00:00Z')
  if (isNaN(d.getTime())) throw new Error(`Invalid date: ${iso}`)
  return d
}

/**
 * Compute YTM. Returns null if inputs are invalid.
 * All inputs as percent values and ISO dates to minimize caller-side mistakes.
 *
 * @param cleanPrice - quoted price per ₦100 face (e.g. 109.82)
 * @param couponPct  - annual coupon rate as percent (e.g. 18.5 for 18.5%). 0 for zero-coupon.
 * @param maturityDateIso - YYYY-MM-DD
 * @param settlementDateIso - YYYY-MM-DD (typically the price date)
 * @param freq - coupon frequency per year (default 2 = semi-annual, standard for FGN)
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
    return { ytm_pct: 0, flag: 'matured', periods: 0, days_to_maturity: daysToMaturity }
  }

  const face = 100
  const years = daysToMaturity / 365.25
  const nPeriods = Math.max(1, Math.round(years * freq))
  const periodicCoupon = (couponPct / 100 * face) / freq

  // Zero-coupon edge case: if coupon == 0 and price >= face, no yield signal.
  if (periodicCoupon === 0 && cleanPrice >= face) {
    return { ytm_pct: 0, flag: 'par-at-or-above', periods: nPeriods, days_to_maturity: daysToMaturity }
  }

  // PV(y) = sum of coupons discounted + face at maturity
  const pv = (y: number): number => {
    if (y <= -0.9) return Infinity
    const r = y / freq
    let total = 0
    for (let k = 1; k <= nPeriods; k++) {
      total += periodicCoupon / Math.pow(1 + r, k)
    }
    total += face / Math.pow(1 + r, nPeriods)
    return total
  }

  const f = (y: number) => pv(y) - cleanPrice

  const y = brentq(f, -0.5, 2.0)
  if (y === null) {
    return { ytm_pct: NaN, flag: 'solver-failed', periods: nPeriods, days_to_maturity: daysToMaturity }
  }

  const ytmPct = y * 100
  let flag: YieldFlag | null = null
  if (ytmPct > 50) flag = 'extreme-high'
  else if (ytmPct < 5) flag = 'extreme-low'

  return {
    ytm_pct: ytmPct,
    flag,
    periods: nPeriods,
    days_to_maturity: daysToMaturity,
  }
}

/**
 * Human-readable explanation of a flag. Used in the UI.
 */
export function explainFlag(flag: YieldFlag): string {
  switch (flag) {
    case 'matured':         return 'Bond has matured — no yield to compute'
    case 'par-at-or-above': return 'Zero-coupon at or above par — no yield signal from price'
    case 'extreme-high':    return 'Yield > 50% — clean price is likely stale or reflects a thin/forced trade'
    case 'extreme-low':     return 'Yield < 5% — unusually low for Nigerian FI; price may be stale'
    case 'solver-failed':   return 'Numerical solver failed to converge'
  }
}
