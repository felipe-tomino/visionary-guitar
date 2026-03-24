# Roboflow Workflow Setup Guide

## Quick Setup (JSON Editor)

1. Go to **Roboflow Dashboard** → `tominoprod` workspace
2. Navigate to **Workflows** → **Create Workflow** → name it `guitar-scales`
3. Open the **JSON Editor** and paste the contents of `workflow/workflow.json`
4. Save the workflow

> **Note**: If `dynamic_blocks_definitions` is not supported on Roboflow's hosted platform,
> the JSON will configure all built-in blocks correctly. You'll need to add the two Custom
> Python blocks manually (see Manual Setup below) and paste code from the `.py` files.

## Manual Setup (UI Blocks)

If the JSON editor doesn't support the custom Python blocks, add blocks manually:

### Inputs

| Name | Type | Default |
|------|------|---------|
| `image` | Image | (default) |
| `scale_name` | String | `"major"` |
| `root_note` | Integer | `2` |
| `tuning` | String | `"standard"` |
| `fret_count` | Integer | `12` |

### Block Order

> **Important**: ByteTracker must come BEFORE Detection Stabilizer.
> The Stabilizer needs `tracker_id` to smooth per-object trajectories.

| # | Block | Input | Key Settings |
|---|-------|-------|-------------|
| 1 | Instance Segmentation Model | `image` | model: `visionary-guitar/8` |
| 2 | ByteTracker | predictions from #1 | `track_activation_threshold: 0.5`, `lost_track_buffer: 15` |
| 3 | Detection Stabilizer | tracked from #2 | `smoothing_window_size: 5`, `bbox_smoothing_coefficient: 0.4` |
| 4 | Detections Filter (fret wires) | stabilized from #3 | class == `fret wire` AND confidence >= `0.65` |
| 5 | Detections Filter (landmarks) | stabilized from #3 | class in [`nut`, `soundhole`, `fretboard`] AND confidence >= `0.3` |
| 6 | Custom Python — Geometry Engine | #4 + #5 outputs | Paste `workflow/geometry_engine.py` |
| 7 | Custom Python — Scale Renderer | #6 output + `image` + params | Paste `workflow/scale_renderer.py` |

### Block 6: Geometry Engine Inputs
- `fret_wire_detections`: output from Block 4
- `landmark_detections`: output from Block 5

### Block 7: Scale Renderer Inputs
- `geometry_data`: output from Block 6
- `image`: original `image` input
- `scale_name`: from workflow input
- `root_note`: from workflow input
- `tuning`: from workflow input
- `fret_count`: from workflow input

### Output
- Name: `annotated_image` (from Block 7)
- Returned via WebRTC video track

## Block Connection Diagram

```
Inputs (image, scale_name, root_note, tuning, fret_count)
    │
    ▼
[Instance Segmentation Model: visionary-guitar/8]
    │
    ▼
[ByteTracker]                    ◀── assigns tracker_id
    │
    ▼
[Detection Stabilizer]           ◀── smooths per tracker_id
    │
    ├──▶ [Filter: fret wires (conf≥0.65)] ──────┐
    │                                             │
    └──▶ [Filter: landmarks (conf≥0.3)] ─────────┤
                                                  │
                                                  ▼
                                    [Geometry Engine] ◀── stateful (calibration)
                                         │
                                         ▼
                                    [Scale + Renderer] ◀── image + params
                                         │
                                         ▼
                                    Output: annotated_image
```

## Notes

- Custom Python blocks use `self._state` (via `init`) for cross-frame persistence
- The Geometry Engine maintains calibration state (geometry lock, fret positions)
- Detections arrive as `sv.Detections` objects — code converts to dicts internally
- Scale/tuning/root changes require a WebRTC reconnection (parameters set at connection time)
- Stabilizer and ByteTracker parameters can be tuned after initial testing
