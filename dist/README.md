# Intrepid · Layer Studio

Layer Studio converts STL geometry into an SLC 2.0 build with variable layer thickness. The default layer is **100 µm**; the preferred faster layer is **150 µm**, based on your prior process research. You can choose any whole-number thickness from **50 to 200 µm**. The app does not independently establish a resin’s optimum thickness.

## Prepare and scan

1. Choose STL units before dropping or selecting files. STL does not record units; millimeters are the default. Check the displayed dimensions after import.
2. Rotate parts as needed, add copies, and enter the build-plate dimensions, clearance, and margin.
3. Select **Scan & optimize**. The tool grounds each part and arranges its rectangular footprint on the plate. It tries several packing orders and optional 90° rotations around Z. It preserves scale and your selected tilt. This is a packing heuristic, not a guarantee of the best possible arrangement or print orientation.
4. Review the side view, section callouts, layer preview, warnings, and time comparison before export.

Import automatically removes exact duplicate and zero-area facets and attempts conservative stitching of uniquely matching seams no wider than 1 µm. The part card and geometry diagnostics report any cleanup. The slicer connects intersections through shared mesh edges, preserving very short valid segments instead of misreporting them as open contours. Missing faces, ambiguous connections, overlapping solids, and inconsistent winding still require editing in your mesh software; cleanup does not invent surfaces.

A progress panel stays visible while reading files, checking meshes, planning, slicing, and verifying the SLC. Reading shows actual bytes; processing shows progress for the current stage, or an animated bar when no measured total is available. Cancel stops the operation without replacing your previous geometry.

The app does not generate supports, hollow parts, or merge intersecting solids. Each imported STL is packed independently: separate part and support STLs are not automatically recognized as an aligned assembly. Separate part/support SLC output from another slicer does not itself explain an open-contour error here.

## Set the layer schedule

Automatic planning uses the preferred thickness on sections classified as vertical exterior walls. Other sections retain the 100 µm baseline. The vertical tolerance controls how closely an exterior wall must align with Z.

Internal nested contours are excluded from this classification so internal lattice does not automatically force smaller layers. This is a geometric approximation: the tool cannot reliably distinguish lattice from a functional cavity, and open or externally visible lattice may affect classification. Inspect critical features and use manual sections where needed. Classification does not predict surface roughness (Ra), stair stepping, cure quality, or dimensional accuracy.

The **support cutoff** applies the preferred thickness from the build bottom to the height you enter. It marks a region of existing geometry as eligible for faster printing; it does not create or identify supports. Set it to zero when that exception is inappropriate. For multiple parts, every section applies across the entire build at that Z height.

Use the side-view selection or section fields to specify a start, end, and thickness. Manual sections override automatic and support choices. Section boundaries snap to **0.05 mm (50 µm)** and overlapping manual ranges are rejected. The final build height is represented to the nearest micrometer; transition or terminal layers may be adjusted to keep every layer within 50–200 µm. Review the actual schedule and adjustment notices.

## Resins and time estimates

Create a resin profile and supply measured **Ec in mJ/cm²**, **Dp in µm**, and build-plane **irradiance in mW/cm²**. Set the cure-depth factor and any additional depth allowance. Required cure depth is `thickness × factor + allowance`; exposure time is `(Ec / irradiance) × exp(required depth / Dp)`.

Enter per-layer motion/settling overhead, optional setup time, and any initial-layer exposure override. The comparison uses the same build height and assumptions for the proposed schedule and a nominal 100 µm schedule. Without complete exposure inputs, only known timing components are available; that is not a complete print-time estimate. The demo resin contains illustrative, uncalibrated values.

The model assumes uniform exposure and fixed irradiance and cycle overhead. It does not model scan-path time, area-dependent peeling, thermal effects, oxygen inhibition, or changing resin behavior. Calibrate on your printer, resin, wavelength, and conditions, then validate printed coupons. Profiles are saved in this browser; exporting settings provides a portable record.

## Export and share

SLC export writes **minimum-Z contour records** with a sampling table. Each mask is sampled near the middle of its physical layer interval. Successive record heights alone are insufficient to reconstruct every layer: the internal printer must honor the SLC sampling table and terminating height. The exporter supports at most **255 consecutive thickness runs**; simplify alternating sections if that limit is exceeded.

Download the companion recipe for the schedule, resin inputs, timing assumptions, placement information, and reported cleanup/recovery. A singular sampling plane may move by a tiny recorded amount while physical layer heights remain unchanged. SLC itself does not carry the exposure recipe. A recipe is not a geometry archive: reload the STL files and verify units, orientation, and placement when rebuilding a job. Verify representative constant and variable-thickness files in your internal reader before production use.

Limits include 32 parts, 200 MB per imported batch, 20,000 layers, and 3 million exported contour vertices. There is no hard triangle-count cap; browser memory and processing time still constrain complex files.

Models are processed locally in your browser and are not uploaded by the app. Sharing the app URL does not share models, resin profiles, or settings. Reloading the page clears the loaded geometry.

## References

- [NIST working-curve study](https://www.nist.gov/publications/results-interlaboratory-study-working-curve-vat-photopolymerization): calibration and variability.
- [Autodesk SLC reference](https://help.autodesk.com/cloudhelp/2024/ENU/Alias-Reference/files/File-menu/File-Export/GUID-9F07E039-DE0F-463E-98B8-8A1AAD432A7F.html) and [reproduced 3D Systems SLC 2.0 specification](https://www.paulbourke.org/dataformats/slc/): format conventions.
