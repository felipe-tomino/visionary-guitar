# Roboflow Workflow Setup Guide

## Quick Setup (JSON Editor)

1. Go to **Roboflow Dashboard** → `tominoprod` workspace
2. Navigate to **Workflows** → **Create Workflow** → name it `guitar-full-workflow`
3. Open the **JSON Editor** and paste the contents of `workflow/workflow.json`
4. Save the workflow

> **Note**: If `dynamic_blocks_definitions` is not supported on Roboflow's hosted platform,
> the JSON will configure all built-in blocks correctly. You'll need to add the Custom
> Python block manually (see Manual Setup below) and paste code from the `.py` file.

## Manual Setup (UI Blocks)

If the JSON editor doesn't support the custom Python block, add blocks manually:

### Inputs

| Name | Type | Default |
|------|------|---------|
| `image` | Image | (default) |
| `fret_wire_class` | String | `"fret wire"` |
| `fret_wire_conf` | Float | `0.65` |
| `landmark_classes` | String | `"nut,soundhole,fretboard"` |
| `landmark_conf` | Float | `0.3` |

### Block Order

| # | Block | Input | Key Settings |
|---|-------|-------|-------------|
| 1 | Instance Segmentation Model | `image` | model: `visionary-guitar/8` |
| 2 | Detections Filter (fret wires) | predictions from #1 | class == `fret wire` AND confidence >= `0.65` |
| 3 | Detections Filter (landmarks) | predictions from #1 | class in [`nut`, `soundhole`, `fretboard`] AND confidence >= `0.3` |
| 4 | Custom Python — Geometry Engine | #2 + #3 outputs | Paste `workflow/geometry_engine.py` |

### Block 4: Geometry Engine Inputs
- `fret_wire_detections`: output from Block 2
- `landmark_detections`: output from Block 3

### Output
- Name: `geometry_data` (JSON from Block 6)
- Returned via WebRTC **data channel** (not video track)

## Block Connection Diagram

```
Input (image)
    │
    ▼
[Instance Segmentation Model: visionary-guitar/8]
    │
    ├──▶ [Filter: fret wires (conf≥0.65)] ──────┐
    │                                             │
    └──▶ [Filter: landmarks (conf≥0.3)] ─────────┤
                                                  │
                                                  ▼
                                    [Geometry Engine] ◀── stateful (calibration)
                                         │
                                         ▼
                                    Output: geometry_data (JSON)
```

## Notes

- The Geometry Engine uses module-level `_state` dict with `global _state` for cross-frame persistence
- The engine maintains calibration state (geometry lock, fret positions, anchor smoothing)
- The engine includes `image_width`/`image_height` in output for client-side coordinate scaling
- Detections arrive as `sv.Detections` objects — code converts to dicts internally
- Scale/tuning/root changes are handled client-side (no reconnection needed)
- The client renders notes on a canvas overlay over the live webcam feed
