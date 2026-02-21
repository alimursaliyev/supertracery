# SuperTracery

**AI-powered object tracking overlays for After Effects.**

SuperTracery is a CEP (Common Extensibility Platform) panel for Adobe After Effects that uses Meta's SAM2 (Segment Anything Model 2) to automatically segment and track objects across video frames, then generates animated shape layer overlays directly in your composition.

## Features

### Object Picking with Live SAM2 Preview
- Pick tracking points directly from an in-panel fullscreen overlay of the current frame
- Real-time SAM2 segmentation preview on hover — shows mask outline, bounding box, and confidence score before you click
- Crosshair cursor with live coordinate readout
- Supports picking multiple objects for multi-object tracking

### SAM2 Segmentation & Tracking
- Click-to-segment: point at any object and SAM2 identifies its full mask
- Temporal propagation across all frames using SAM2's video predictor
- Fallback pipeline: flood-fill segmentation + optical flow propagation when SAM2 is unavailable
- Per-frame analysis: centroid, bounding box, contour polygon, area, luminosity, motion vectors

### Overlay Generation
Generates animated After Effects shape layers from tracking data:

| Overlay | Description |
|---------|-------------|
| **BOUNDING_BOX** | Animated rectangle tracking the object bounds |
| **CENTER_MARKER** | Dot at the object centroid |
| **LABEL** | Text label following each object |
| **MOTION_ARROW** | Direction/magnitude arrow from motion vectors |
| **MASK_OUTLINE** | Animated polygon path tracing the object contour with configurable fill |
| **CONNECTIONS** | Lines between tracked objects (sequential, star, full mesh, or MST topology) |

### Visualization Controls
- **STROKE_WIDTH** — 1px to 6px slider
- **OVERLAY_OPACITY** — 10% to 100% slider
- **MASK_FILL_OPACITY** — 0% to 50% slider (visible when mask is enabled)
- **CONNECTION_MODE** — none / sequential / star / full / MST
- **LINE_STYLE** — straight / curved / dashed
- **Per-object colors** — click the color swatch next to any tracked point to customize

### Other
- Cached frame export — skips re-rendering if frames already exist
- Progress bar with live stdout from the Python tracker
- Cancel tracking mid-run
- Clear all points and cached data
- Auto-refreshes composition info on panel load

## Architecture

```
supertracery/
├── CSXS/manifest.xml          # CEP extension manifest (AE 2023+)
├── CSInterface.js              # Adobe CSInterface library
├── index.html                  # Panel UI
├── css/style.css               # Full panel styling (JetBrains Mono, dark theme)
├── js/main.js                  # Panel controller — CEP bridge, picker, tracking, overlays
├── jsx/bridge.jsx              # ExtendScript — comp info, frame export, overlay generation
└── python/
    ├── supertracery.py         # CLI entry point: JSON config → results.json
    ├── tracker.py              # SAM2 model loading, segmentation, propagation, analysis
    └── preview_server.py       # Persistent SAM2 process for live picker preview
```

### Data Flow

```
[Pick Point] → export current frame via AE render queue
            → show in-panel overlay with SAM2 preview server
            → user clicks → store (x, y) coordinates

[Run Tracking] → export all frames via AE render queue (or use cached)
              → spawn Python subprocess with JSON config
              → SAM2 segments first frame → propagates across video
              → per-frame analysis → results.json

[Generate Overlays] → write results + options to temp JSON files
                    → JSX reads files, creates animated shape layers in comp
```

### Communication

- **JS ↔ ExtendScript**: `CSInterface.evalScript()` with JSON string returns
- **JS ↔ Python**: `child_process.spawn()` with stdout line protocol (`PROGRESS:N/TOTAL`, `INFO:...`, `ERROR:...`, `DONE`)
- **JS ↔ Preview Server**: persistent stdin/stdout JSON line protocol for real-time SAM2 queries

## Requirements

- **Adobe After Effects** 2023 or later (CEP 12+)
- **Python 3.8+** with a virtual environment at `python/venv/`
- **Python packages**: `torch`, `sam2`, `numpy`, `opencv-python`, `scipy`
- **SAM2 model**: auto-downloaded on first run (`facebook/sam2-hiera-large`, falls back to `sam2-hiera-small`)

## Installation

1. Clone or symlink the repo to the CEP extensions directory:
   ```bash
   # macOS
   ln -s /path/to/supertracery \
     ~/Library/Application\ Support/Adobe/CEP/extensions/com.supertracery.panel

   # Windows
   mklink /D "%APPDATA%\Adobe\CEP\extensions\com.supertracery.panel" \path\to\supertracery
   ```

2. Enable unsigned extensions (development mode):
   ```bash
   # macOS
   defaults write com.adobe.CSXS.12 PlayerDebugMode 1

   # Windows — set registry key:
   # HKCU\Software\Adobe\CSXS.12 → PlayerDebugMode = 1
   ```

3. Set up the Python environment:
   ```bash
   cd supertracery/python
   python3 -m venv venv
   source venv/bin/activate
   pip install torch torchvision sam2 opencv-python scipy numpy
   ```

4. Restart After Effects. Open the panel via **Window → Extensions → SuperTracery**.

## Usage

1. Open a composition in After Effects
2. Click **PICK POINT FROM FRAME** — the current frame opens in a fullscreen overlay
3. Hover to see the SAM2 preview mask, then click on the object to track
4. Repeat to add more objects
5. Click **RUN_TRACKING** — exports all frames and runs SAM2 propagation
6. Configure visualization toggles and options
7. Click **GENERATE_OVERLAYS** — creates animated shape layers in the comp

## Tech Stack

- **Frontend**: HTML/CSS/JS in CEP panel (Chromium Embedded Framework)
- **Scripting**: ExtendScript (ES3) for After Effects DOM manipulation
- **AI/ML**: SAM2 (Segment Anything Model 2) via PyTorch
- **Computer Vision**: OpenCV for mask analysis, optical flow fallback
- **Runtime**: Node.js (via CEP `--enable-nodejs`) for filesystem and subprocess access
