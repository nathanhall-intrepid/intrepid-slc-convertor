import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateProfile, exposureSeconds, estimateTime, baselineLayers, compareTimes,
  exposureEfficiencySweep, DEMO_PROFILE, formatDuration,
} from '../dist/process.js';

const resin = { ecMjCm2: 8, dpUm: 100, irradianceMwCm2: 4, cureDepthFactor: 1, cureDepthAllowanceUm: 0 };
const approx = (actual, expected, tolerance=1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

test('Jacobs inversion retains unit conversion and cure-depth inputs', () => {
  approx(exposureSeconds(100, resin), 2 * Math.E);
  approx(exposureSeconds(150, resin) / exposureSeconds(100, resin), Math.exp(.5));
  approx(exposureSeconds(100, {...resin, cureDepthFactor: 1.2, cureDepthAllowanceUm: 30}), exposureSeconds(150, resin));
  approx(exposureSeconds(100, {...resin, irradianceMwCm2: 8}), Math.E);
});

test('missing profile never silently becomes complete print time', () => {
  const validation = validateProfile({ name: 'My resin', ecMjCm2: 8 });
  assert.equal(validation.valid, true);
  assert.equal(validation.complete, false);
  assert.deepEqual(validation.missing, ['dpUm', 'irradianceMwCm2']);
  assert.equal(exposureSeconds(100, {}), null);
  const time = estimateTime(baselineLayers(.3), {}, {overheadSeconds: 7, setupSeconds: 20});
  assert.equal(time.totalSeconds, null);
  assert.equal(time.unknownExposureLayers, 3);
  assert.equal(time.knownSeconds, 41);
  assert.equal(time.exposureSeconds, null);
  assert.equal(time.status, 'partial');
  const comparison = compareTimes([{thicknessUm: 150}, {thicknessUm: 150}], {}, {overheadSeconds: 7});
  assert.equal(comparison.savedSeconds, null);
  assert.equal(comparison.savedPercent, null);
  assert.equal(comparison.overheadSavedSeconds, 7);
});

test('base exposure replaces ordinary exposure, overhead applies to every layer', () => {
  const time = estimateTime(baselineLayers(.4), resin, {overheadSeconds: 5, setupSeconds: 60, baseLayerCount: 2, baseExposureSeconds: 25});
  approx(time.exposureSeconds, 50 + 4 * Math.E);
  approx(time.totalSeconds, 130 + 4 * Math.E);
  assert.equal(time.overheadSeconds, 20);
  assert.equal(time.layerCount, 4);
  const unknown = estimateTime(baselineLayers(.4), resin, {overheadSeconds: 5, baseLayerCount: 2});
  assert.equal(unknown.totalSeconds, null);
  assert.equal(unknown.unknownExposureLayers, 2);
  approx(unknown.knownSeconds, 20 + 4 * Math.E);
  const allBase = estimateTime(baselineLayers(.2), {}, {overheadSeconds: 5, baseLayerCount: 5, baseExposureSeconds: 25});
  assert.equal(allBase.totalSeconds, 60);
  assert.equal(allBase.baseLayerCount, 2);
});

test('legal baseline preserves exact height without a sub-50 micrometre final layer', () => {
  for (const heightUm of [50, 51, 99, 100, 101, 140, 149, 150, 199, 201, 249, 300, 10001]) {
    for (const nominal of [50, 75, 100, 150, 200]) {
      const result = baselineLayers(heightUm / 1000, nominal);
      assert.equal(result.reduce((s,l) => s+l.thicknessUm,0), heightUm);
      assert.ok(result.every(l => l.thicknessUm >= 50 && l.thicknessUm <= 200));
      assert.equal(result.at(-1).zMm, heightUm / 1000);
    }
  }
  assert.deepEqual(baselineLayers(.21).map(l=>l.thicknessUm), [100,60,50]);
  assert.throws(()=>baselineLayers(.049), /at least/);
  assert.throws(()=>baselineLayers(.12345), /integer micrometre/);
});

test('savings use exposure and overhead; thicker layers can take longer', () => {
  const layers = [{thicknessUm:150,zMm:.15}, {thicknessUm:150,zMm:.3}];
  const result = compareTimes(layers, resin, {overheadSeconds:8});
  approx(result.optimized.totalSeconds, 16 + 4*Math.exp(1.5));
  approx(result.baseline.totalSeconds, 24 + 6*Math.E);
  assert.ok(result.savedSeconds > 0);
  const noOverhead = compareTimes(layers, {...resin, dpUm: 50}, {overheadSeconds:0});
  assert.ok(noOverhead.savedSeconds < 0);
  assert.ok(noOverhead.savedPercent < 0);
});

test('invalid inputs and arithmetic overflow are explicit failures', () => {
  for (const invalid of [0,-1,NaN,Infinity]) {
    assert.equal(validateProfile({...resin, dpUm:invalid}).valid, false);
    assert.throws(()=>exposureSeconds(100,{...resin,dpUm:invalid}));
  }
  assert.throws(()=>exposureSeconds(49,resin), /50 and 200/);
  assert.throws(()=>exposureSeconds(201,resin), /50 and 200/);
  assert.throws(()=>exposureSeconds(200,{...resin,dpUm:.000001}), /24 hours/);
  assert.throws(()=>estimateTime([{thicknessUm:100,zMm:0}],resin), /Z endpoints/);
  assert.throws(()=>estimateTime([{thicknessUm:100,zMm:'bad'}],resin), /Z endpoints/);
  assert.throws(()=>estimateTime([{thicknessUm:100}],resin,{overheadSeconds:-1}));
  assert.throws(()=>estimateTime([{thicknessUm:100}],resin,{baseLayerCount:1.5}));
});

test('demo labels, empty schedules and optional efficiency curve are honest', () => {
  const result = estimateTime(baselineLayers(.3),DEMO_PROFILE);
  assert.equal(result.illustrative,true);
  assert.match(result.warnings[0], /Illustrative/);
  assert.equal(compareTimes([],resin).optimized.totalSeconds,0);
  const noProfile = exposureEfficiencySweep({});
  assert.equal(noProfile.bestThicknessUm,null);
  const sweep = exposureEfficiencySweep(resin,{overheadSeconds:0},1);
  assert.equal(sweep.bestThicknessUm,100);
  assert.equal(formatDuration(null),'Not estimated');
  assert.equal(formatDuration(3661),'1h 01m');
});
