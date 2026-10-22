# SLC module contract

`encodeSLC(layers, options)` returns a `Uint8Array`. Input layers use **end Z** in mm, integer `thicknessUm` from 50 through 200, and rings as `[x,y]` coordinates. Rings may include or omit a final duplicate of the first point. Exteriors must be counter-clockwise and holes clockwise. The exporter rejects intersecting/touching contours and ambiguous schedules; it never silently repairs them.

`decodeSLC(bytes)` reads the result and expands repeated contours to physical layers. It returns `layers`, raw `contours`, `samplingTable`, `topZMm`, header and metadata. `samplingTableForLayers(layers)` lets the UI check format capacity before slicing.

## Streaming API

`createSLCEncoder(planLayers, options)` provides `addLayer(layer)` and `finish()`. Each layer is validated, encoded, and checked against its serialized bytes before its geometry arrays are released. The encoder retains encoded chunks and small `layerMetadata` records. `finish()` assembles a `Uint8Array`; peak output allocation temporarily includes both chunks and the final buffer. `stats` reports layer counts, verified layers, contour and encoded vertex counts, and `collapsedVertices`.

Only consecutive endpoints that become identical at SLC float32 precision are coalesced. Original and converted contours must pass topology checks; nonadjacent repeated vertices, collapsed rings, intersections, and invalid winding remain errors. Coalescing is reported in the export warnings and recipe.

`decodeSLC(bytes, {retainGeometry:false, onProgress})` validates one contour at a time and retains schedule metadata with `ringCount` and `vertexCount`, without geometry arrays. Progress reports measured bytes. Counts are checked against available input bytes rather than an arbitrary cumulative vertex cap. The worker compares decoded schedule and counts with the planned and encoded layers.

## Format evidence

The [reproduced 3D Systems SLC 2.0 specification](https://www.paulbourke.org/dataformats/slc/) describes an ASCII header terminated by CR/LF/control-Z, 256 reserved bytes, a byte-sized sampling count, 16-byte sampling entries, and little-endian float32/uint32 contour records. Contour Z is a **minimum**: it applies until the next contour or the top-of-part record. The latter contains top Z and `0xFFFFFFFF`, without contour geometry. Closed boundaries explicitly repeat their first vertex. [Autodesk's first-party exporter documentation](https://help.autodesk.com/cloudhelp/2024/ENU/Alias-Reference/files/File-menu/File-Export/GUID-9F07E039-DE0F-463E-98B8-8A1AAD432A7F.html) confirms units, model types, header metadata, and closed PART/SUPPORT contours. The original standalone 1994 specification was not retrieved.

## Engineering decisions

Each input endpoint is converted to minimum Z by subtracting its thickness. No synthetic empty top slice is added. Each thickness change creates a sampling entry; identical consecutive thicknesses share one entry. The text claims up to 256 entries while allocating only one byte and does not define a zero-means-256 convention. Therefore this writer supports **1–255 runs** and reports a clear error above that count. Do not truncate, wrap, or substitute a uniform table.

SLC stores contour geometry and sampling, not resin exposure settings. Save a companion plan/recipe separately. Name is not written as a nonstandard header field. Optional `extents: {min:[x,y,z],max:[x,y,z]}` supplies the original model bounds; otherwise exported contour bounds are used. `packageName` is ASCII-limited to 32 characters. Browser output is bounded at 512 MiB, one million layers, and a finite per-slice geometry-validation budget.

Tests include an independently assembled byte fixture for a repeated cube contour, variable-thickness table/terminator checks, winding and intersection rejection, truncation, and the 255-run boundary. Hardware compatibility still requires a representative import into the internal printer reader.
