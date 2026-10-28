# Delivery and validation

The application is implemented and its 68 automated checks pass. The checks cover ASCII and binary STL, invalid/open geometry, exterior versus internal features, manual/support precedence, legal terminal layers, packing, exposure/time estimates, binary SLC layout, and actual worker messages and transfers. Regression checks accept 504,300 triangles in both STL formats and 504,600 combined triangles through worker import and slicing. There is no hard triangle-count cap.

Contour regressions reproduce false open loops on a closed rotated cube near vertex elevations. Canonical shared-edge reconstruction now preserves those contours without moving the sampling plane. Other checks cover bounded singular-plane recovery shared by preview/export, exact duplicate and zero-area cleanup, unique precision seams, rejection of genuine gaps/missing faces, preservation of close separate solids, intermediate progress, and structured failure heights through worker messages. UI behavior checks cover byte reading, cancellation and restart, stale-worker isolation, indeterminate stages, and error cleanup. Streaming export validates and serializes each layer without retaining contour arrays for the entire build. A regression streams more than three million contour vertices, with no triangle-count or cumulative contour-vertex cap. Final SLC read-back validates geometry one contour at a time and compares its schedule and counts with the encoded layers. General hole filling and assembly-aware support placement remain outside this implementation.

The Windows launcher was also tested from the user's home folder with only the persistent Windows PATH. It successfully located the existing Codex Node runtime and started the server. Use the full launcher path when calling it from outside the application folder.

Local browser smoke checks passed for the demo scan, WebGL side view and section callouts, and downloading a 334-layer SLC with export read-back validation. The import and geometry pipeline are also exercised by the automated tests. This is not a physical-printer or measured-surface-quality validation.

GitHub Pages deployment is configured by `.github/workflows/pages.yml`. The repository's Actions and Pages settings provide the current deployment status and published URL; see `HOSTING.md`. The hosted app runs without a local server or command window.

## Check on your computer

1. Install a recent Node.js release if needed. Extract the package and run `npm start` from its folder.
2. Open `http://127.0.0.1:4317`. The demonstration model should load automatically.
3. Compare the colored side view and height callouts with the layer schedule. Select a region and add a manual band.
4. Load `tests/fixtures/cube.stl`, scan, and export an SLC. Recheck the imported units and displayed dimensions.
5. Add your measured resin values and cycle time, and export the companion JSON recipe.
6. Import representative SLC files into your internal printer reader before using them for a build. Confirm the minimum-Z records, sampling table, termination height, and midpoint contour convention described in `slc-contract.md`.

The `dist/` folder can be served by static web hosting. Geometry and profiles are processed locally in each visitor's browser. The app does not generate support structures, infer actual Ra, or establish a resin's optimum thickness.

## Intrepid SVG header compatibility

A header-only control in Intrepid SVG Converter 2.1.0 confirmed that setting EXTENTS maximum Z to the last contour plane resolves a conversion stall. The binary sampling table, contour records, and final-layer-top sentinel remained identical. Both fixed and variable schedule controls converted successfully. The writer now follows this contour-plane header convention even when model bounds are supplied. Regression checks verify mixed layers, a single layer, preserved XY bounds and unchanged final top. This is importer compatibility verification, not physical printer validation.

## Automatic solid and SLC precision repair (2026-10-28)

The import worker combines overlapping closed, outward-oriented shells using bundled Manifold 3.5.4. Every resulting mesh is rechecked for exact-coordinate edge closure, consistent winding, degenerate facets, positive volume and bounds. Negative cavity shells and unresolved openings remain unchanged. Intersection sliver cleanup uses 0.1 µm tolerance.

SLC recovery is restricted to full-precision contours that already pass validation. If float32 conversion creates a conflict, polygon cleanup is checked against a 1 µm boundary envelope, then closure, nesting, winding and every emitted layer are verified again. Reports record affected layers, area changes and any tiny closing operation. These changes may merge submicron gaps or remove slivers.

Synthetic regressions cover overlapping solids, a shared non-manifold edge, unchanged disjoint solids, cavity preservation, unresolved missing faces, short-edge intersection precision and float32 notch collapse. A local support-heavy fixture with 368,808 original triangles and 227 non-manifold edges was repaired to 713,748 triangles with zero open/non-manifold edges and unchanged overall bounds. Its complete 102-layer adaptive SLC (22,604,549 bytes) passed export/read-back validation. Two layers required bounded coordinate precision recovery. Customer geometry is not included in the public repository.
