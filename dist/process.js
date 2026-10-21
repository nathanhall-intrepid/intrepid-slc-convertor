/** Resin working-curve estimates. No profile below is a validated print recipe. */
export const MIN_LAYER_UM = 50;
export const MAX_LAYER_UM = 200;
export const BASELINE_LAYER_UM = 100;
export const PREFERRED_LAYER_UM = 150;

export const DEMO_PROFILE = Object.freeze({
  id: 'demo-illustrative',
  name: 'Demo resin · illustrative only',
  demo: true,
  ecMjCm2: 6,
  dpUm: 150,
  irradianceMwCm2: 4,
  cureDepthFactor: 1.1,
  cureDepthAllowanceUm: 0,
});

export const DEFAULT_CYCLE = Object.freeze({
  overheadSeconds: 8,
  setupSeconds: 0,
  baseLayerCount: 0,
  baseExposureSeconds: null,
});

const absent = value => value === undefined || value === null || value === '';
const numberOrNull = value => absent(value) ? null : Number(value);

/** Return validation data; incomplete user profiles are allowed to be saved. */
export function validateProfile(input = {}) {
  const profile = {
    id: String(input.id ?? ''),
    name: String(input.name ?? 'Unnamed resin').trim().slice(0, 100) || 'Unnamed resin',
    demo: input.demo === true,
    ecMjCm2: numberOrNull(input.ecMjCm2),
    dpUm: numberOrNull(input.dpUm),
    irradianceMwCm2: numberOrNull(input.irradianceMwCm2),
    cureDepthFactor: absent(input.cureDepthFactor) ? 1 : Number(input.cureDepthFactor),
    cureDepthAllowanceUm: absent(input.cureDepthAllowanceUm) ? 0 : Number(input.cureDepthAllowanceUm),
  };
  const errors = [];
  const missing = [];
  for (const [key, label] of [
    ['ecMjCm2', 'Ec (mJ/cm²)'],
    ['dpUm', 'Dp (µm)'],
    ['irradianceMwCm2', 'Irradiance (mW/cm²)'],
  ]) {
    if (profile[key] === null) missing.push(key);
    else if (!Number.isFinite(profile[key]) || profile[key] <= 0) errors.push(`${label} must be a positive finite number.`);
  }
  if (!Number.isFinite(profile.cureDepthFactor) || profile.cureDepthFactor < 1) {
    errors.push('Cure-depth factor must be finite and at least 1.');
  }
  if (!Number.isFinite(profile.cureDepthAllowanceUm) || profile.cureDepthAllowanceUm < 0) {
    errors.push('Additional cure depth must be a finite nonnegative number of micrometres.');
  }
  return { valid: errors.length === 0, complete: errors.length === 0 && missing.length === 0, errors, missing, profile };
}

function requireThickness(thicknessUm) {
  const h = Number(thicknessUm);
  if (!Number.isFinite(h) || h < MIN_LAYER_UM - 1e-7 || h > MAX_LAYER_UM + 1e-7) {
    throw new RangeError('Layer thickness must be between 50 and 200 µm.');
  }
  return h;
}

function checkedProfile(input) {
  const result = validateProfile(input);
  if (!result.valid) throw new RangeError(result.errors.join(' '));
  return result;
}

/**
 * Cd = Dp ln(E/Ec), E = I t.
 * required cure depth = thickness * factor + additive allowance.
 * mJ/cm² divided by mW/cm² gives seconds. Return null for missing data.
 */
export function exposureSeconds(thicknessUm, input = {}) {
  const h = requireThickness(thicknessUm);
  const result = checkedProfile(input);
  if (!result.complete) return null;
  const p = result.profile;
  const cureDepthUm = h * p.cureDepthFactor + p.cureDepthAllowanceUm;
  const logSeconds = Math.log(p.ecMjCm2) - Math.log(p.irradianceMwCm2) + cureDepthUm / p.dpUm;
  // An overflow or a >24 h single-layer prediction is an input/model problem,
  // not a useful duration to display as a plausible print estimate.
  if (!Number.isFinite(logSeconds) || logSeconds > Math.log(86400)) {
    throw new RangeError('The working curve predicts more than 24 hours of exposure per layer. Check Ec, Dp, irradiance, and units.');
  }
  const seconds = Math.exp(logSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new RangeError('The working curve cannot produce a finite positive exposure with these values.');
  return seconds;
}

export function validateCycle(input = {}) {
  const c = {
    overheadSeconds: absent(input.overheadSeconds) ? DEFAULT_CYCLE.overheadSeconds : Number(input.overheadSeconds),
    setupSeconds: absent(input.setupSeconds) ? DEFAULT_CYCLE.setupSeconds : Number(input.setupSeconds),
    baseLayerCount: absent(input.baseLayerCount) ? DEFAULT_CYCLE.baseLayerCount : Number(input.baseLayerCount),
    baseExposureSeconds: numberOrNull(input.baseExposureSeconds),
  };
  const errors = [];
  for (const key of ['overheadSeconds', 'setupSeconds']) {
    if (!Number.isFinite(c[key]) || c[key] < 0) errors.push(`${key} must be finite and nonnegative.`);
  }
  if (!Number.isSafeInteger(c.baseLayerCount) || c.baseLayerCount < 0) errors.push('Base-layer count must be a nonnegative whole number.');
  if (c.baseExposureSeconds !== null && (!Number.isFinite(c.baseExposureSeconds) || c.baseExposureSeconds < 0 || c.baseExposureSeconds > 86400)) {
    errors.push('Base-layer exposure must be between 0 and 86400 seconds.');
  }
  return { valid: errors.length === 0, errors, cycle: c };
}

/**
 * Schedule entries need thicknessUm; optional zMm must increase and match their
 * thicknesses. A first entry zMm=0 is not a printable interval and is rejected.
 * Both ordinary and base layers each incur one overhead cycle.
 */
export function estimateTime(layers, input = {}, cycleInput = {}) {
  if (!Array.isArray(layers)) throw new TypeError('Layers must be an array.');
  const validation = checkedProfile(input);
  const cycleResult = validateCycle(cycleInput);
  if (!cycleResult.valid) throw new RangeError(cycleResult.errors.join(' '));
  const p = validation.profile;
  const c = cycleResult.cycle;
  let knownExposureSeconds = 0;
  let unknownExposureLayers = 0;
  let totalHeightUm = 0;
  const byThickness = {};
  const exposures = new Map();
  for (let i = 0; i < layers.length; i++) {
    const h = requireThickness(layers[i].thicknessUm);
    totalHeightUm += h;
    if (layers[i].zMm !== undefined) {
      const z = Number(layers[i].zMm);
      if (!Number.isFinite(z) || Math.abs(z * 1000 - totalHeightUm) > 0.02) {
        throw new RangeError('Layer Z endpoints do not match the accumulated thicknesses.');
      }
    }
    byThickness[h] = (byThickness[h] ?? 0) + 1;
    let exposure;
    if (i < c.baseLayerCount) exposure = c.baseExposureSeconds;
    else {
      if (!exposures.has(h)) exposures.set(h, exposureSeconds(h, p));
      exposure = exposures.get(h);
    }
    if (exposure === null) unknownExposureLayers++;
    else knownExposureSeconds += exposure;
  }
  const overheadSeconds = c.overheadSeconds * layers.length;
  const setupSeconds = layers.length ? c.setupSeconds : 0;
  const knownSeconds = knownExposureSeconds + overheadSeconds + setupSeconds;
  if (!Number.isFinite(knownSeconds)) throw new RangeError('Estimated time exceeds the supported numeric range.');
  const complete = unknownExposureLayers === 0;
  const warnings = [];
  if (p.demo) warnings.push('Illustrative demo resin and cycle assumptions; not calibrated printer settings.');
  if (!validation.complete && layers.length) warnings.push('Enter Ec, Dp, and irradiance to estimate normal-layer exposure.');
  if (c.baseLayerCount && c.baseExposureSeconds === null) warnings.push('Enter base-layer exposure to include those layers in the total.');
  if (!complete) warnings.push('Only known exposure and cycle overhead are included. This is not total print time.');
  return {
    complete,
    status: complete ? 'complete' : 'partial',
    totalSeconds: complete ? knownSeconds : null,
    knownSeconds,
    exposureSeconds: complete ? knownExposureSeconds : null,
    knownExposureSeconds,
    overheadSeconds,
    setupSeconds,
    unknownExposureLayers,
    layerCount: layers.length,
    baseLayerCount: Math.min(c.baseLayerCount, layers.length),
    totalHeightMm: totalHeightUm / 1000,
    byThickness,
    warnings,
    missingProfileFields: validation.missing,
    illustrative: p.demo,
  };
}

/**
 * Nominal uniform baseline with exact integer-micrometre span. A final segment
 * under 50 µm borrows from its predecessor, or merges if the nominal layer is
 * already 50 µm. Adjustments remain inside 50–200 µm.
 */
export function baselineLayers(heightMm, thicknessUm = BASELINE_LAYER_UM) {
  const h = requireThickness(thicknessUm);
  if (!Number.isInteger(h)) throw new RangeError('Nominal baseline thickness must be a whole number of micrometres.');
  const inputHeight = Number(heightMm);
  const heightUm = Math.round(inputHeight * 1000);
  if (!Number.isFinite(inputHeight) || heightUm < MIN_LAYER_UM) throw new RangeError('Build height must be at least 0.05 mm.');
  if (heightUm > 10000000) throw new RangeError('Build height exceeds 10 metres. Check STL units.');
  if (Math.abs(inputHeight * 1000 - heightUm) > 1e-4) throw new RangeError('Baseline height must be rounded to an integer micrometre by the layer planner.');
  const heights = new Array(Math.floor(heightUm / h)).fill(h);
  let remainder = heightUm % h;
  if (remainder >= MIN_LAYER_UM) heights.push(remainder);
  else if (remainder > 0) {
    if (!heights.length) heights.push(heightUm);
    else {
      const last = heights.pop();
      if (last + remainder <= MAX_LAYER_UM && last + remainder < 2 * MIN_LAYER_UM) heights.push(last + remainder);
      else {
        const secondLast = last + remainder - MIN_LAYER_UM;
        if (secondLast >= MIN_LAYER_UM) heights.push(secondLast, MIN_LAYER_UM);
        else heights.push(last + remainder);
      }
    }
  }
  let zUm = 0;
  return heights.map(value => {
    requireThickness(value);
    zUm += value;
    return { zMm: zUm / 1000, thicknessUm: value, reason: value === h ? 'baseline' : 'baseline-end-adjustment' };
  });
}

/** Compare equal-height schedules. Partial time must not become savings %. */
export function compareTimes(layers, input = {}, cycle = {}, baselineUm = BASELINE_LAYER_UM) {
  const optimized = estimateTime(layers, input, cycle);
  const baseline = estimateTime(layers.length ? baselineLayers(optimized.totalHeightMm, baselineUm) : [], input, cycle);
  const complete = optimized.complete && baseline.complete;
  const savedSeconds = complete ? baseline.totalSeconds - optimized.totalSeconds : null;
  return {
    optimized,
    baseline,
    savedSeconds,
    savedPercent: complete && baseline.totalSeconds > 0 ? 100 * savedSeconds / baseline.totalSeconds : null,
    layerReductionPercent: baseline.layerCount ? 100 * (baseline.layerCount - optimized.layerCount) / baseline.layerCount : 0,
    overheadSavedSeconds: baseline.overheadSeconds - optimized.overheadSeconds,
  };
}

/**
 * Informational curve-only efficiency. Never used to change the user's 150 µm
 * preference or to override geometric/roughness restrictions.
 */
export function exposureEfficiencySweep(input = {}, cycleInput = {}, stepUm = 10) {
  if (!Number.isInteger(stepUm) || stepUm < 1 || stepUm > 50) throw new RangeError('Sweep step must be 1–50 µm.');
  const checked = checkedProfile(input);
  if (!checked.complete) return { available: false, samples: [], bestThicknessUm: null };
  const cycleResult = validateCycle(cycleInput);
  if (!cycleResult.valid) throw new RangeError(cycleResult.errors.join(' '));
  const samples = [];
  for (let h = MIN_LAYER_UM; h <= MAX_LAYER_UM; h += stepUm) {
    const exposure = exposureSeconds(h, checked.profile);
    samples.push({ thicknessUm: h, exposureSeconds: exposure, secondsPerMm: 1000 * (exposure + cycleResult.cycle.overheadSeconds) / h });
  }
  if (samples.at(-1).thicknessUm !== MAX_LAYER_UM) {
    const exposure = exposureSeconds(MAX_LAYER_UM, checked.profile);
    samples.push({ thicknessUm: MAX_LAYER_UM, exposureSeconds: exposure, secondsPerMm: 1000 * (exposure + cycleResult.cycle.overheadSeconds) / MAX_LAYER_UM });
  }
  const best = samples.reduce((a, b) => b.secondsPerMm < a.secondsPerMm ? b : a);
  return { available: true, samples, bestThicknessUm: best.thicknessUm, label: 'Curve-only cycle estimate; geometry and print quality are not considered.' };
}

export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds)) || Number(seconds) < 0) return 'Not estimated';
  const total = Math.round(Number(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours ? `${hours}h ${String(minutes).padStart(2, '0')}m` : minutes ? `${minutes}m ${String(secs).padStart(2, '0')}s` : `${secs}s`;
}
