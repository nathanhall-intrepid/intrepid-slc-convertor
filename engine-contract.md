# STL engine contract

All mesh coordinates are millimetres. STL itself is unitless: `parseSTL(buffer,name,{unitScale:1})` uses an explicit scale. Binary files with `solid` headers are detected by their exact record length. ASCII and binary inputs return `{name,positions:Float64Array,triangleCount,bounds:{min,max,size,center},format,unitScale}`.

`analyzeMesh(mesh)` returns manifold/open-edge and winding diagnostics, signed/absolute volume, surface area, bounds, and the coordinate weld tolerance. Results cache on the mesh. `transformMesh(mesh,{rotation:[xDeg,yDeg,zDeg],translation:[x,y,z],ground:true})` creates a transformed copy; it clears cached geometry and analysis. `ground` moves the transformed mesh's lowest Z to zero.

`sliceAt(meshes,zMm,{validate:true})` returns `{rings,depths,outerRings,areaMm2,outerMaxNormalZ,vertexCount,toleranceMm}`. Rings omit their closing duplicate. Exteriors are CCW; holes CW. Geometry is intersected with a horizontal plane, stitched using a bounds-scaled coordinate tolerance, and checked for open junctions, self intersections and conflicting source facet orientation. A globally reversed closed mesh is accepted. Mixed winding or nested overlapping positive solids must be repaired; the tool does not guess which are voids. Separate placed parts may not touch or overlap.

`planLayers(meshes,options,onProgress)` supports:

- `baselineUm:100`, `preferredUm:150`; integer values from 50 through 200.
- `supportEndMm:0`, explicitly supplied by the UI/user. This marks a region; it does not create supports.
- `overrides:[{id,fromMm,toMm,thicknessUm}]`; overlapping overrides are rejected.
- `verticalToleranceDeg:3`, `automatic:true`.

It returns `{layers,heightMm,heightUm,actualHeightMm,baselineUm,preferredUm,supportEndMm,overrides,warnings,classificationSamples,maskConvention}`. Each printable layer is `{index,zMm,zStartMm,thicknessUm,requestedUm,reason,classification,adjusted}`. `reason` is support, manual, vertical or standard. There is no artificial Z=0 anchor. `zMm` is the interval **end**. The SLC writer converts this to its minimum-Z record.

Height-range boundaries snap to 50 µm increments, with reported warnings. The final mesh height rounds to the nearest micron (at most 0.5 µm difference). All actual layers remain integer 50–200 µm. Terminal steps may differ from the requested thickness to fit exact section endpoints; `adjusted` marks them. A 51 µm-high section cannot physically be represented as exact 50 µm layers without truncation, so it gets one 51 µm interval.

Automatic fast layers are permitted when the **outermost** slice boundaries remain vertical to the angle tolerance. Facet slopes are evaluated on slice segments at near-endpoints and in intervals between relevant vertex Z events. Dense internal events are excluded only when their complete XY triangle projections lie strictly inside a vertical outer enclosure whose contributing facets span the whole candidate layer interval. This prevents a temporarily hidden exterior shoulder from being mistaken for internal geometry. Exterior horizontal caps and ledges inside a candidate interval explicitly retain baseline layers. More than 24 remaining distinct candidate events conservatively retains baseline and produces a warning; densely tessellated exterior walls or near-vertical enclosures that cannot be proved constant can therefore yield less speed-up.

Nested internal contours do not drive the decision; STL cannot semantically distinguish lattice from critical internal cavities, and the returned warning says so. The actual sliced masks always preserve internal contours; their exclusion applies only to automatic thickness selection. Support and manual bands intentionally override automatic criteria.

`sliceBuild(meshes,plan,onProgress)` performs actual slicing and adds `rings,areaMm2,sampleZMm` to each layer. Masks are sampled at each interval midpoint. A slice exactly through a mesh junction may shift its **sampling plane** by 0.00001 mm inside that interval, without changing layer endpoints. It checks watertightness and consistent facet winding before export.

Callbacks emit `{stage:'planning'|'slicing',current,total,percent}` synchronously, suitable for posting from a web worker. Cancel by terminating the worker. Browser limits: 200 MB STL, 20,000 layers and 3 million exported contour vertices. There is no hard triangle-count cap; browser memory and processing time still constrain complex files. `createBoxMesh` and `createDemoMesh` provide closed test/demo fixtures.

Tests run with `node --test tests/engine.test.mjs` and cover parsing, dimensions, topology, cavity winding, overlap refusal, vertical/slope planning, dense internal event exclusion, brief exterior cap/slope protection, manual overrides, final-height fitting, and end-to-end SLC encoding/decoding. `node tests/engine-benchmark.mjs` is an optional performance smoke with 100,016- and 480,016-triangle closed fixtures; it checks a 400-layer schedule without imposing a machine-dependent timing threshold.
