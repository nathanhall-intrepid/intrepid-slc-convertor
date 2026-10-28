# Intrepid SLC Convertor · Layer Studio

A static, browser-local STL-to-SLC planner with build-plate packing, 50–200 µm variable layers, manual Z sections, resin profiles, exposure estimates, and a companion process recipe. See [the user guide](dist/README.md) for the workflow and limitations.

GitHub Pages can run the app directly in your browser without Node.js or a command window. See [hosting setup](HOSTING.md) and the repository's Pages deployment for its published link.

## Run locally

On Windows, extract the ZIP and double-click `Start-Layer-Studio.cmd`. Keep its window open and visit `http://127.0.0.1:4317`. The launcher can use Node.js installed on your PATH or the existing Codex bundled runtime. If running it from another folder in Command Prompt, use its full quoted path.

Use a recent Node.js release and a modern browser with WebGL and module-worker support. No package installation or build step is required.

```sh
npm start
```

Open <http://127.0.0.1:4317>. The development server binds only to localhost. Opening `dist/index.html` directly from the filesystem is unsupported because the app uses ES modules and a worker.

Run the automated suite with:

```sh
npm test
```

Tests cover STL parsing and contour/planning invariants, packing, resin/time calculations, SLC encoding and decoding, and worker integration. They do not validate a physical printer, measured roughness, or resin process settings.

## Integration

Deploy the contents of `dist/` to static hosting with JavaScript modules served using the appropriate MIME type. The app needs no server-side geometry processing, database, API keys, or external runtime libraries. Three.js and Manifold (including Clipper2 polygon operations) are vendored with their licenses in `dist/vendor/`.

- `engine.js`: mesh parsing, diagnostics, transforms, slicing, and layer planning.
- `layout.js`: conservative rectangular packing with optional additional Z rotation.
- `process.js`: Jacobs-curve exposure calculations, timing, and equal-height baseline comparison.
- `slc.js`: SLC 2.0 encoding, decoding, and sampling-table checks.
- `worker.js`: bounded background import, planning, slicing, and export validation.
- `app.js` / `viewer.js`: controls and interactive visual review.

Public module contracts and engineering details are in `engine-contract.md`, `process-contract.md`, and `slc-contract.md`. Internal planning uses end-of-layer heights. SLC contour records use minimum Z; masks sample each layer’s interior, usually its midpoint. A consumer must use the sampling table and termination height to reconstruct physical layers. SLC contains no resin/exposure settings, so integrate the companion JSON recipe separately.

## Scope and restrictions

The nominal layer is 100 µm and preferred fast layer is 150 µm. Preferred thickness remains a user process choice, not an inferred material optimum. All exported physical layers are integer micrometers within 50–200 µm. Manual/support boundaries snap to 50 µm; terminal adjustments preserve the quantized model height without undersized layers.

Packing is heuristic and preserves the supplied tilt. Each STL is placed independently; separate part/support files are not automatically grouped as an aligned assembly. Exterior-wall classification is geometric; nested contours are ignored but are not semantically identified as lattice. The support cutoff labels existing geometry and does not generate supports. Import performs reported duplicate/zero-area cleanup and conservative precision-seam stitching (at most 1 µm). Overlapping closed, outward-oriented shells within one STL can be unioned automatically, with reported 0.1 µm sliver cleanup. Cavity shells are preserved. General hole filling is not implemented. Valid contours that collide only after float32 rounding can be repaired within a checked 1 µm boundary band; affected layers are recorded in the recipe. Shared-edge contour assembly prevents numerical false-open errors; unresolved defects retain structured diagnostics. The app does not predict Ra. Incomplete resin inputs produce incomplete timing, not a fabricated total; demo values are illustrative.

The fixed progress panel covers file reading, geometry checks/cleanup, planning, slicing, encoding, and read-back verification. It displays measured byte counts or stage progress and supports cancellation during both file reading and worker processing.

Worker limits: 32 parts, 200 MB per imported batch, 20,000 layers, and 512 MB of encoded SLC output. There is no hard triangle-count or total contour-vertex cap. Export slices, checks, and encodes one layer at a time to keep working memory bounded by a layer plus the output file; browser memory and processing time still constrain complex files. SLC export limits the sampling table to 255 thickness runs. Export is checked through the local decoder; compatibility with the internally developed printer still requires representative hardware/import validation.

Geometry stays in browser memory and is not uploaded by the app. Profiles use browser local storage. Shared URLs do not contain geometry or settings, and recipes do not embed STL files. Static-host access logging remains the hosting provider’s responsibility.
