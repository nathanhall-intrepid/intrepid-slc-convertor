# Resin and time module

`dist/process.js` is browser/Node ESM with no dependencies. It does not read storage, send network requests, or alter a layer schedule.

## Contract

- `validateProfile(profile)` returns `{valid, complete, errors, missing, profile}`. It normalizes input strings to numbers. Missing Ec/Dp/irradiance is allowed for a saved draft profile; invalid or negative parameters are not.
- `exposureSeconds(thicknessUm, profile)` returns a number of seconds or `null` for an incomplete profile. Invalid geometry/physics inputs throw a `RangeError` for the UI to show. A prediction greater than 24 hours per layer is treated as an input/model error instead of rendered as an implausible printer duration.
- `estimateTime(layers, profile, cycle)` accepts entries with `thicknessUm` and optional accumulated endpoint `zMm`. There is no zero-height anchor layer in this input. Every layer must be 50–200 µm. It returns complete or partial status, total time (null if incomplete), known exposure time, overhead time, setup time, counts, warnings, and total height.
- `baselineLayers(heightMm, nominalUm=100)` preserves the exact **integer-micrometre** height. If the last remainder would be under 50 µm, it borrows from the preceding layer or combines the remainder. Consequently a terminal layer can differ from nominal. Call with the same height rounded by the geometry planner.
- `compareTimes(layers, profile, cycle)` produces equal-height baseline and optimized estimates and time savings. It returns `savedSeconds`/`savedPercent = null` if either estimate is partial. Overhead-only savings are separately available and must not be labelled total print savings.
- `exposureEfficiencySweep(...)` is an optional informational estimate of time per millimetre. It does not modify the preferred 150 µm setting or account for roughness/geometry.
- `formatDuration(seconds)` renders durations and uses `Not estimated` for null/missing values.

Profile fields: `name`, optional `id`, `ecMjCm2` (mJ/cm²), `dpUm` (µm), `irradianceMwCm2` (mW/cm²), `cureDepthFactor` (at least 1, default 1), `cureDepthAllowanceUm` (nonnegative, default 0), optional `demo` flag. Required cure depth is `h × factor + allowance`; displaying both controls clearly avoids confusing the two ways of specifying extra cure depth.

Cycle fields: `overheadSeconds` (per-layer peel, motion, settling and other non-exposure time combined), `setupSeconds` (once per nonempty build), `baseLayerCount`, `baseExposureSeconds`. Base exposure replaces the ordinary curve-predicted exposure for those initial layers. The support-height input is independent from base-layer count.

`DEMO_PROFILE` contains explicitly illustrative Ec=6 mJ/cm², Dp=150 µm, I=4 mW/cm² and cure-depth factor=1.1; it is not tied to any commercial resin or validated printer. `DEFAULT_CYCLE.overheadSeconds=8` is an editable assumption. The interface should label demo data and initial cycle assumptions. Changing to a user profile should not silently inherit demo calibration values unless the user explicitly retains them.

## Model and limitations

The Jacobs working curve is `Cd = Dp ln(E/Ec)`; with constant irradiance `I`, `E=I t`, giving `t=(Ec/I) exp(Cd/Dp)`. Required exposure grows exponentially with desired cure depth in this model. Therefore fewer layers do not automatically mean lower total print time. The model assumes flood exposure with constant irradiance across the layer and constant user-entered non-exposure overhead; it does not predict raster/vector scan time for a laser toolpath. Geometry-dependent peel or refill time needs a printer-specific model. Temperature, resin wavelength pairing, ageing, photobleaching, reciprocity changes and actual interlayer adhesion can change results. The tool should describe times as estimates based on entered measurements, not measured outcomes.

Ec/Dp alone do not establish an optimal printed layer thickness or surface roughness. The user's prior 150 µm result should remain the preferred fast setting. A resin-based efficiency graph, if shown, must not override geometric exclusions or user selections.

Primary references:

- [NIST, Results of an Interlaboratory Study on the Working Curve in Vat Photopolymerization (2024)](https://tsapps.nist.gov/publication/get_pdf.cfm?pub_id=957007): equation and variable definitions; the paper also explains substantial measurement scatter and dependence on resin/light-source pairing.
- [Formlabs, How Formlabs Develops and Validates Print Settings for the Creator Series Resins](https://creator.formlabs.com/blogs/home-page/how-formlabs-developed-validated-print-settings): exposure-curve settings are a starting point for print validation, with motion and light-off delays tuned separately.

These sources support the model and qualification, not the illustrative numbers. No source identifies the user's specific resin or its optimal thickness.
