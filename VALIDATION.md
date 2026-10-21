# Delivery and validation

The application is implemented and its 51 automated checks pass. The checks cover ASCII and binary STL, invalid/open geometry, exterior versus internal features, manual/support precedence, legal terminal layers, packing, exposure/time estimates, binary SLC layout, and actual worker messages and transfers. Regression checks accept 504,300 triangles in both STL formats and 504,600 combined triangles through worker import and slicing. There is no hard triangle-count cap.

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
