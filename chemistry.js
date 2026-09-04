// SpaWaterFix chemistry engine v2 — pure functions, no DOM.
// Contract: LLM/UI parses input -> engine computes doses deterministically -> caller renders/explains.
// Usage: analyzeWater({ gallons: 350, system: 'chlorine' }, { ph: 7.9, ta: 60, fc: 0.5 })

// ─── SANITIZER SYSTEMS ──────────────────────────────────────────────────────
// Target ranges differ by system. 'sanitizer' reading key: fc (free chlorine) or br (bromine), ppm.
const SYSTEMS = {
  chlorine: {
    label: 'Chlorine (dichlor granules)',
    sanitizerKey: 'fc', sanitizerLabel: 'Free Chlorine',
    san: { low: 1, high: 3, warnLow: 0.5, warnHigh: 5, max: 10 },
    ta:  { low: 80, high: 120, warnLow: 60, warnHigh: 150, max: 240 },
    raiseProduct: 'spa chlorinating granules dichlor',
    raiseLabel: 'Dichlor chlorinating granules',
    // 1 oz dichlor per 500 gal raises FC ~4.1 ppm -> tsp (1/6 oz) per gal factor
    raiseTspPerPpmPer100Gal: 0.293,
    shockNote: 'Shock weekly with dichlor or MPS; after heavy use.'
  },
  bromine: {
    label: 'Bromine (tablets or granules)',
    sanitizerKey: 'br', sanitizerLabel: 'Bromine',
    san: { low: 3, high: 5, warnLow: 2, warnHigh: 8, max: 12 },
    ta:  { low: 80, high: 120, warnLow: 60, warnHigh: 150, max: 240 },
    raiseProduct: 'spa brominating concentrate granules',
    raiseLabel: 'Brominating concentrate',
    // SpaGuard brominating concentrate: 1 tsp ~0.625 ppm in 400 gal
    raiseTspPerPpmPer100Gal: 0.4,
    shockNote: 'Shock with MPS or chlorine to regenerate the bromide bank.'
  },
  'frog-bromine': {
    label: 'FROG mineral + bromine (e.g. Serene)',
    sanitizerKey: 'br', sanitizerLabel: 'Bromine',
    // FROG spec: minerals allow lower bromine 1-2 ppm; TA per FROG guidance
    san: { low: 1, high: 2, warnLow: 0.5, warnHigh: 4, max: 10 },
    ta:  { low: 120, high: 150, warnLow: 80, warnHigh: 180, max: 240 },
    raiseProduct: 'spa brominating concentrate granules',
    raiseLabel: 'Brominating concentrate (or adjust FROG dial)',
    raiseTspPerPpmPer100Gal: 0.4,
    shockNote: 'Shock with MPS per FROG guidance; check cartridge levels.'
  },
  'chlorine-mineral': {
    label: 'Mineral + chlorine (e.g. FROG @ease, Nature2)',
    sanitizerKey: 'fc', sanitizerLabel: 'Free Chlorine',
    san: { low: 0.5, high: 1, warnLow: 0.3, warnHigh: 3, max: 10 },
    ta:  { low: 80, high: 120, warnLow: 60, warnHigh: 150, max: 240 },
    raiseProduct: 'spa chlorinating granules dichlor',
    raiseLabel: 'Dichlor chlorinating granules (or adjust cartridge)',
    raiseTspPerPpmPer100Gal: 0.293,
    shockNote: 'Shock with MPS; verify mineral cartridge is not expired.'
  }
};

// ─── SHARED PARAMETER RANGES (system-independent) ───────────────────────────
const SHARED = {
  ph:   { label: 'pH', low: 7.2, high: 7.8, ideal: [7.4, 7.6], warnLow: 7.0, warnHigh: 8.0, max: 9, unit: '' },
  ch:   { label: 'Calcium Hardness', low: 150, high: 250, warnLow: 100, warnHigh: 400, max: 600, unit: 'ppm' },
  phos: { label: 'Phosphates', low: 0, high: 125, warnLow: 0, warnHigh: 500, max: 1000, unit: 'ppb' },
  tds:  { label: 'Total Dissolved Solids', low: 0, high: 1500, warnLow: 0, warnHigh: 2500, max: 4000, unit: 'ppm' }
};

// ─── DOSE MATH (all rates normalized per 100 gallons) ───────────────────────
// Sources: standard sodium bicarb / soda ash / sodium bisulfate / calcium chloride rates.
const RATES = {
  taUpTspPerPpmPer100Gal: 0.12,      // sodium bicarbonate
  phUpTspPer01Per100Gal: 0.25,       // soda ash, per 0.1 pH
  phDownTspPer01Per100Gal: 0.25,     // sodium bisulfate, per 0.1 pH
  chUpTspPerPpmPer100Gal: 0.171      // calcium chloride
};

function fmtDose(tsp) {
  if (tsp <= 0) return 'none needed';
  if (tsp < 0.75) return '½ tsp';
  if (tsp < 1.5) return '1 tsp';
  if (tsp < 2.5) return '2 tsp';
  const tbsp = tsp / 3;
  if (tbsp < 1.25) return '1 tbsp';
  if (tbsp < 1.75) return '1½ tbsp';
  if (tbsp < 2.25) return '2 tbsp';
  if (tbsp < 2.75) return '2½ tbsp';
  if (tbsp < 3.5) return '3 tbsp';
  if (tbsp < 4.5) return '4 tbsp';
  const cups = tbsp / 16;
  if (cups < 0.375) return '¼ cup';
  if (cups < 0.625) return '½ cup';
  if (cups < 0.875) return '¾ cup';
  return Math.round(cups * 4) / 4 + ' cup' + (cups >= 2 ? 's' : '');
}
const needsDivide = tsp => tsp / 3 > 3;

// ─── MAIN ───────────────────────────────────────────────────────────────────
// profile: { gallons: number, system: key of SYSTEMS }
// readings: { ph?, ta?, ch?, phos?, tds?, fc? | br? }  (NaN/undefined = not tested)
function analyzeWater(profile, readings) {
  const gallons = Number(profile.gallons);
  const sys = SYSTEMS[profile.system];
  if (!gallons || gallons < 50 || gallons > 3000) return { error: 'Volume must be 50–3000 gallons.' };
  if (!sys) return { error: `Unknown system. Options: ${Object.keys(SYSTEMS).join(', ')}` };
  const g100 = gallons / 100;
  const r = k => { const v = Number(readings[k]); return Number.isFinite(v) ? v : null; };

  const san = r(sys.sanitizerKey);
  const ph = r('ph'), ta = r('ta'), ch = r('ch'), phos = r('phos'), tds = r('tds');
  if ([san, ph, ta, ch, phos, tds].every(v => v === null)) return { error: 'No readings provided.' };

  // gauges
  const gauge = (key, label, v, cfg, unit) => v === null ? null : {
    key, label, value: v, unit: unit ?? cfg.unit ?? 'ppm',
    low: cfg.low, high: cfg.high, max: cfg.max,
    status: v < cfg.low ? 'LOW' : v > cfg.high ? 'HIGH' : 'OK',
    severity: (v < (cfg.warnLow ?? -1) || v > (cfg.warnHigh ?? 1e9)) ? 'danger'
            : (v < cfg.low || v > cfg.high) ? 'warn' : 'ok'
  };
  const gauges = [
    gauge(sys.sanitizerKey, sys.sanitizerLabel, san, sys.san),
    gauge('ph', 'pH', ph, SHARED.ph, ''),
    gauge('ta', 'Total Alkalinity', ta, sys.ta),
    gauge('ch', 'Calcium Hardness', ch, SHARED.ch),
    gauge('phos', 'Phosphates', phos, SHARED.phos),
    gauge('tds', 'TDS', tds, SHARED.tds)
  ].filter(Boolean);

  // corrective steps: TA -> pH -> CH -> phosphates -> sanitizer last
  const steps = [];

  if (ta !== null && ta < sys.ta.low) {
    const tsp = (sys.ta.low + 10 - ta) * RATES.taUpTspPerPpmPer100Gal * g100;
    steps.push(step('danger-if', ta < sys.ta.warnLow, 'Low Total Alkalinity',
      `${ta} ppm · target ${sys.ta.low}–${sys.ta.high}`,
      'Alkalinity increaser (sodium bicarbonate)', 'spa alkalinity increaser',
      `Add ${fmtDose(tsp)}`, [
        needsDivide(tsp) ? 'Divide into 3 doses, 1 hour apart' : null,
        'Jets on while adding', 'Wait 1 hour, retest before next step'
      ], 'Low TA lets pH swing and corrodes equipment.'));
  } else if (ta !== null && ta > sys.ta.high) {
    const tsp = Math.min((ta - sys.ta.high) * RATES.phDownTspPer01Per100Gal * 0.8 * g100, 6 * g100);
    steps.push(step('warn', false, 'High Total Alkalinity',
      `${ta} ppm · target ${sys.ta.low}–${sys.ta.high}`,
      'pH decreaser (sodium bisulfate)', 'spa ph decreaser sodium bisulfate',
      `Add ${fmtDose(tsp)}`, [
        'Add in small doses over 2–3 days; retest between',
        'After TA is in range, aerate (jets on, cover off) to bring pH back up without raising TA'
      ], 'High TA locks pH high and clouds water.'));
  }

  if (ph !== null && ph < SHARED.ph.low) {
    const tsp = ((SHARED.ph.ideal[0] - ph) / 0.1) * RATES.phUpTspPer01Per100Gal * g100;
    steps.push(step('danger-if', ph < SHARED.ph.warnLow, 'Low pH',
      `${ph} · target 7.2–7.8`, 'pH increaser (soda ash)', 'spa ph increaser',
      `Add ${fmtDose(tsp)}`, ['Jets on', 'Retest after 30 minutes',
        (ta !== null && ta >= sys.ta.low) ? 'Tip: running jets with cover off also raises pH without chemicals' : null],
      'Acidic water corrodes heaters and stings skin.'));
  } else if (ph !== null && ph > SHARED.ph.high) {
    const tsp = ((ph - SHARED.ph.ideal[1]) / 0.1) * RATES.phDownTspPer01Per100Gal * g100;
    steps.push(step('danger-if', ph > SHARED.ph.warnHigh, 'High pH',
      `${ph} · target 7.2–7.8`, 'pH decreaser (sodium bisulfate)', 'spa ph decreaser sodium bisulfate',
      `Add ${fmtDose(tsp)}`, ['Jets on', 'Retest after 30 minutes'],
      'High pH weakens sanitizer and causes scale/cloudiness.'));
  }

  if (ch !== null && ch < SHARED.ch.low) {
    const tsp = (SHARED.ch.low + 25 - ch) * RATES.chUpTspPerPpmPer100Gal * g100;
    steps.push(step('warn', false, 'Low Calcium Hardness',
      `${ch} ppm · target 150–250`, 'Calcium hardness increaser', 'spa calcium hardness increaser',
      `Add ${fmtDose(tsp)}`, ['Pre-dissolve in a bucket of warm water', 'Jets on, add slowly'],
      'Soft water foams and is corrosive to equipment.'));
  } else if (ch !== null && ch > SHARED.ch.high) {
    const drainPct = Math.round(((ch - 200) / ch) * 100);
    steps.push(step('warn', ch > SHARED.ch.warnHigh, 'High Calcium Hardness',
      `${ch} ppm · target 150–250`, 'Partial drain & refill (no chemical lowers CH)', null,
      `Drain ~${Math.max(10, Math.min(drainPct, 75))}% and refill`,
      ['Use a hose-end pre-filter when refilling if your fill water is hard',
       'A stain & scale product keeps excess calcium in solution meanwhile'],
      'High CH causes scale, especially on the heater.'));
  }

  if (phos !== null && phos > SHARED.phos.high) {
    steps.push(step('warn', phos > SHARED.phos.warnHigh, 'High Phosphates',
      `${phos} ppb · target < 125`, 'Phosphate remover', 'spa phosphate remover',
      `Dose per label for ${gallons} gallons`, ['Expect temporary clouding; run filter, then rinse filter next day'],
      'Phosphates feed algae and consume sanitizer.'));
  }

  if (san !== null && san < sys.san.low) {
    const tsp = (((sys.san.low + sys.san.high) / 2) - san) * sys.raiseTspPerPpmPer100Gal * g100;
    steps.push(step('danger-if', san < sys.san.warnLow, `Low ${sys.sanitizerLabel}`,
      `${san} ppm · target ${sys.san.low}–${sys.san.high}`, sys.raiseLabel, sys.raiseProduct,
      `Add ${fmtDose(tsp)}`, ['Jets on, cover off 15 minutes', 'Retest in 30 minutes', sys.shockNote],
      'Unsanitized water is unsafe — fix this before soaking.'));
  } else if (san !== null && san > sys.san.high) {
    steps.push(step('warn', san > sys.san.warnHigh, `High ${sys.sanitizerLabel}`,
      `${san} ppm · target ${sys.san.low}–${sys.san.high}`, 'Time (no product needed)', null,
      'Leave cover off, jets on; levels fall on their own',
      [san > sys.san.warnHigh ? 'Do not soak until back in range' : 'Soaking is OK near the top of range',
       'Reduce feeder/dial setting to prevent recurrence'],
      'High sanitizer irritates skin, eyes, and degrades the cover.'));
  }

  if (tds !== null && tds > SHARED.tds.high) {
    steps.push(step('warn', tds > SHARED.tds.warnHigh, 'High TDS — water is aging out',
      `${tds} ppm · fresh water < 1500`, 'Drain & refill', null,
      'Plan a drain and refill; no chemical reverses TDS',
      ['Run a line flush before draining', 'Refill through a hose-end pre-filter'],
      'Saturated water stops responding to chemicals.'));
  }

  // quality scores 0..1
  const clamp = x => Math.max(0, Math.min(1, x));
  const scores = {
    comfort: clamp(1
      - (ph !== null && (ph < 7.4 || ph > 7.6) ? 0.25 : 0)
      - (san !== null && (san < sys.san.low || san > sys.san.high) ? 0.25 : 0)
      - (ch !== null && ch < 100 ? 0.2 : 0)),
    clarity: clamp(1
      - (ta !== null && (ta < sys.ta.low || ta > sys.ta.high) ? 0.2 : 0)
      - (tds !== null && tds > 1500 ? 0.3 : 0)
      - (phos !== null && phos > 125 ? 0.25 : 0)),
    protection: clamp(1
      - (san !== null && san < sys.san.low ? 0.4 : 0)
      - (ph !== null && (ph < 7.2 || ph > 7.8) ? 0.3 : 0)
      - (phos !== null && phos > 500 ? 0.3 : 0))
  };

  return {
    profile: { gallons, system: profile.system, systemLabel: sys.label },
    gauges, scores, steps,
    allOk: steps.length === 0,
    summary: steps.length === 0
      ? 'All tested parameters are in range. Enjoy your soak.'
      : `${steps.length} correction${steps.length > 1 ? 's' : ''} needed, in the order listed.`
  };

  function step(sevMode, isDanger, title, subtitle, productLabel, productQuery, dose, instructions, warning) {
    return {
      severity: sevMode === 'warn' ? (isDanger ? 'danger' : 'warn') : (isDanger ? 'danger' : 'warn'),
      title, subtitle, product: productLabel,
      productQuery,          // feed to Amazon search link: /s?k=<query>&tag=spawaterfix-20
      dose,
      instructions: instructions.filter(Boolean),
      warning
    };
  }
}

// Browser global (index.html loads this file with <script type="module"> and reads window.SpaChem).
if (typeof window !== 'undefined') window.SpaChem = { SYSTEMS, SHARED, analyzeWater, fmtDose };
// ES exports (worker.js imports these; `window` does not exist in the Workers runtime).
export { SYSTEMS, SHARED, analyzeWater, fmtDose };
