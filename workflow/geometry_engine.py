"""
Geometry Engine — Custom Python Block for Roboflow Workflows

Inputs:
  - fret_wire_detections: sv.Detections (filtered: class=fret wire, conf>=0.65)
  - landmark_detections: sv.Detections (filtered: class in [nut, soundhole, fretboard], conf>=0.3)

Output:
  - geometry_data: dict with calibration state, anchor positions, fret positions
"""

import numpy as np
import cv2
import math
import time

# ═══════════════════════════════════════════════════
# CONSTANTS
# ═══════════════════════════════════════════════════

FRET_RATIO = 2 ** (-1 / 12)  # ~0.9439 (equal temperament)
GEOMETRY_STABLE_TIME_MS = 1500
MIN_FRET_NUT_DISTANCE = 15
MIN_FRET_BODY_DISTANCE = 15
NUT_STABILITY_THRESHOLD = 5

# Smoothing factors for values NOT covered by Detection Stabilizer
ANGLE_SMOOTHING = 0.2
GEOMETRY_SMOOTHING = 0.2
SCALE_SMOOTHING = 0.3
FRET_POSITION_SMOOTHING = 0.6
ANCHOR_SMOOTHING = 0.6


# ═══════════════════════════════════════════════════
# sv.Detections → dict conversion
# ═══════════════════════════════════════════════════

def sv_to_dicts(detections):
    """Convert sv.Detections to a list of dicts with polygon support."""
    result = []
    n = len(detections)
    class_names = detections.data.get("class_name", []) if detections.data else []
    masks = detections.mask  # May be None if masks not preserved

    for i in range(n):
        x1, y1, x2, y2 = detections.xyxy[i]
        det = {
            "class_name": class_names[i] if i < len(class_names) else "",
            "cx": float((x1 + x2) / 2),
            "cy": float((y1 + y2) / 2),
            "x1": float(x1), "y1": float(y1),
            "x2": float(x2), "y2": float(y2),
            "width": float(x2 - x1),
            "height": float(y2 - y1),
            "points": [],
        }

        # Extract polygon from mask if available
        if masks is not None and i < len(masks):
            mask = masks[i].astype(np.uint8)
            contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if contours:
                contour = max(contours, key=cv2.contourArea)
                pts = contour.squeeze()
                if len(pts.shape) == 2 and len(pts) >= 3:
                    det["points"] = [{"x": float(p[0]), "y": float(p[1])} for p in pts]

        # Fallback: use bbox corners
        if not det["points"]:
            det["points"] = [
                {"x": float(x1), "y": float(y1)},
                {"x": float(x2), "y": float(y1)},
                {"x": float(x2), "y": float(y2)},
                {"x": float(x1), "y": float(y2)},
            ]

        result.append(det)
    return result


# ═══════════════════════════════════════════════════
# UTILITY FUNCTIONS
# ═══════════════════════════════════════════════════

def smooth_value(current, new_value, factor):
    if current == 0:
        return new_value
    return current + (new_value - current) * factor


def get_centroid(det):
    points = det["points"]
    if not points:
        return {"x": det["cx"], "y": det["cy"]}
    xs = [p["x"] for p in points]
    ys = [p["y"] for p in points]
    return {"x": sum(xs) / len(xs), "y": sum(ys) / len(ys)}


def get_polygon_height(det):
    points = det["points"]
    if len(points) < 2:
        return det["height"]
    ys = [p["y"] for p in points]
    return max(ys) - min(ys)


def fit_line_angle(points):
    if len(points) < 2:
        return 0
    xs = np.array([p["x"] for p in points])
    ys = np.array([p["y"] for p in points])
    mean_x = np.mean(xs)
    mean_y = np.mean(ys)
    numerator = np.sum((xs - mean_x) * (ys - mean_y))
    denominator = np.sum((xs - mean_x) ** 2)
    if abs(denominator) < 0.001:
        return -math.pi / 2
    return math.atan(numerator / denominator)


# ═══════════════════════════════════════════════════
# FRET INTERPOLATION
# ═══════════════════════════════════════════════════

def analyze_and_interpolate_frets(nut_x, detected_positions, max_frets=24, reference_spacing=0):
    if not detected_positions:
        return {"count": 0, "positions": []}
    if len(detected_positions) == 1:
        return {"count": 1, "positions": list(detected_positions)}

    result_positions = []
    prev_x = nut_x

    first_gap = nut_x - detected_positions[0]
    expected_spacing = reference_spacing if reference_spacing > 0 else first_gap

    for i, detected_x in enumerate(detected_positions):
        gap_size = prev_x - detected_x
        if gap_size <= 0:
            continue

        num_frets = 1
        for n in range(1, 7):
            expected_gap_n = expected_spacing * (1 - FRET_RATIO ** n) / (1 - FRET_RATIO)
            expected_gap_n1 = expected_spacing * (1 - FRET_RATIO ** (n + 1)) / (1 - FRET_RATIO)

            if gap_size < expected_gap_n * 0.85:
                num_frets = max(1, n - 1)
                break

            threshold = expected_gap_n + (expected_gap_n1 - expected_gap_n) * 0.4
            if gap_size < threshold:
                num_frets = n
                break

            num_frets = n + 1

        num_frets = max(1, min(num_frets, 6))

        if num_frets == 1:
            result_positions.append(detected_x)
            expected_spacing = gap_size * FRET_RATIO
        else:
            total_ratio_sum = (1 - FRET_RATIO ** num_frets) / (1 - FRET_RATIO)
            first_fret_spacing = gap_size / total_ratio_sum

            for j in range(1, num_frets + 1):
                accumulated = sum(FRET_RATIO ** k for k in range(j))
                t = accumulated / total_ratio_sum
                interpolated_x = prev_x - gap_size * t
                result_positions.append(detected_x if j == num_frets else interpolated_x)

            expected_spacing = first_fret_spacing * (FRET_RATIO ** num_frets)

        prev_x = detected_x
        if len(result_positions) >= max_frets:
            break

    return {"count": len(result_positions), "positions": result_positions}


def smooth_fret_positions(new_positions, previous_positions):
    if not previous_positions:
        return new_positions
    return [
        previous_positions[i] + (pos - previous_positions[i]) * FRET_POSITION_SMOOTHING
        if i < len(previous_positions)
        else pos
        for i, pos in enumerate(new_positions)
    ]


def extend_to_fret_count(positions, target_count):
    if not positions or len(positions) >= target_count:
        return positions
    if len(positions) < 2:
        return positions

    extended = list(positions)
    last_spacing = positions[-2] - positions[-1]
    prev_x = positions[-1]
    current_spacing = last_spacing * FRET_RATIO

    while len(extended) < target_count:
        next_x = prev_x - current_spacing
        extended.append(next_x)
        prev_x = next_x
        current_spacing *= FRET_RATIO

    return extended


def calculate_first_fret_spacing(geometry):
    if not geometry["is_locked"] or geometry["fretboard_length"] <= 0 or geometry["fret_count"] <= 0:
        return 0
    series_sum = (1 - FRET_RATIO ** geometry["fret_count"]) / (1 - FRET_RATIO)
    return geometry["fretboard_length"] / series_sum


# ═══════════════════════════════════════════════════
# CLASSIFICATION & EXTRACTION
# ═══════════════════════════════════════════════════

def classify_detections(landmark_dicts, fret_wire_dicts):
    fretboard = None
    nut = None
    soundhole = None

    for det in landmark_dicts:
        cls = det["class_name"]
        if cls == "fretboard" and fretboard is None:
            fretboard = det
        elif cls == "nut" and nut is None:
            nut = det
        elif cls == "soundhole" and soundhole is None:
            soundhole = det

    return {
        "fretboard": fretboard,
        "nut": nut,
        "soundhole": soundhole,
        "fret_wires": fret_wire_dicts,
    }


def collect_detected_frets(fret_wires, nut_x, soundhole_x):
    positions = []
    for fw in fret_wires:
        centroid = get_centroid(fw)
        if nut_x > 0 and nut_x - centroid["x"] < MIN_FRET_NUT_DISTANCE:
            continue
        if soundhole_x > 0 and centroid["x"] - soundhole_x < MIN_FRET_BODY_DISTANCE:
            continue
        positions.append(centroid["x"])

    positions.sort(reverse=True)
    return positions


# ═══════════════════════════════════════════════════
# ANCHOR EXTRACTION
# ═══════════════════════════════════════════════════

def extract_anchors(state, detections):
    axis_points = []

    if detections["nut"] is not None:
        det = detections["nut"]
        centroid = get_centroid(det)
        state["nut_x"] = smooth_value(state["nut_x"], centroid["x"], ANCHOR_SMOOTHING)
        state["nut_center_y"] = smooth_value(state["nut_center_y"], centroid["y"], ANCHOR_SMOOTHING)
        axis_points.append(centroid)
        state["detected_nut_y"] = {"top": det["y1"], "bottom": det["y2"]}

    for fw in detections["fret_wires"]:
        centroid = get_centroid(fw)
        axis_points.append(centroid)

    if detections["soundhole"] is not None:
        det = detections["soundhole"]
        centroid = get_centroid(det)
        axis_points.append(centroid)

        if not state["geometry"]["is_locked"]:
            rightmost_x = max(det["points"], key=lambda p: p["x"])["x"] if det["points"] else det["x2"]
            state["soundhole_x"] = smooth_value(state["soundhole_x"], rightmost_x, ANCHOR_SMOOTHING)
            state["soundhole_center_y"] = smooth_value(state["soundhole_center_y"], centroid["y"], ANCHOR_SMOOTHING)

    return axis_points


# ═══════════════════════════════════════════════════
# GEOMETRY CALIBRATION
# ═══════════════════════════════════════════════════

def calibrate_geometry(state, detections, frets):
    result = (
        analyze_and_interpolate_frets(state["nut_x"], frets)
        if state["nut_x"] > 0
        else {"count": len(frets), "positions": frets}
    )
    estimated_count = result["count"]
    interpolated = result["positions"]

    state["fret_positions"] = smooth_fret_positions(interpolated, state["fret_positions"])

    geom = state["geometry"]
    if estimated_count > geom["max_frets_seen"]:
        geom["max_frets_seen"] = estimated_count

    if interpolated:
        last_fret_x = interpolated[-1]
        geom["last_fret_x"] = smooth_value(geom["last_fret_x"], last_fret_x, 0.6)

    if detections["nut"] is not None and detections["soundhole"] is not None and estimated_count > 0:
        _learn_geometry(state, detections, estimated_count)
    else:
        geom["stable_start_time"] = 0


def _learn_geometry(state, detections, estimated_count):
    geom = state["geometry"]

    # Learn nut height from polygon
    nut_height = get_polygon_height(detections["nut"])
    if nut_height > 20:
        geom["nut_height"] = (
            nut_height
            if geom["nut_height"] == 0
            else geom["nut_height"] * (1 - GEOMETRY_SMOOTHING) + nut_height * GEOMETRY_SMOOTHING
        )

    # Learn taper from fretboard polygon (needs real polygon data, not just bbox corners)
    if detections["fretboard"] is not None:
        fb_points = detections["fretboard"]["points"]
        sh_cx = detections["soundhole"]["cx"]
        points_near_sh = [p for p in fb_points if abs(p["x"] - sh_cx) < 50]

        if len(points_near_sh) >= 2 and nut_height > 0:
            ys = [p["y"] for p in points_near_sh]
            end_width = max(ys) - min(ys)
            taper = max(0.5, min(1.0, end_width / nut_height))
            geom["taper_ratio"] = geom["taper_ratio"] * (1 - GEOMETRY_SMOOTHING) + taper * GEOMETRY_SMOOTHING

    # Check fret count stability
    now = time.time() * 1000
    is_stable = estimated_count == geom["last_stable_fret_count"]

    if is_stable:
        if geom["stable_start_time"] == 0:
            geom["stable_start_time"] = now
        elapsed = now - geom["stable_start_time"]
        if elapsed >= GEOMETRY_STABLE_TIME_MS:
            _lock_geometry(state, estimated_count)
    else:
        geom["stable_start_time"] = 0
        geom["last_stable_fret_count"] = estimated_count


def _lock_geometry(state, fret_count):
    geom = state["geometry"]
    geom["fret_count"] = fret_count

    if state["nut_x"] > 0 and geom["last_fret_x"] > 0:
        last_fret_dist = abs(state["nut_x"] - geom["last_fret_x"])
        fret_ratio = 1 - FRET_RATIO ** (fret_count - 0.7)
        geom["scale_length"] = last_fret_dist / fret_ratio
        geom["fretboard_length"] = last_fret_dist

    geom["is_locked"] = True


# ═══════════════════════════════════════════════════
# POST-LOCK UPDATES
# ═══════════════════════════════════════════════════

def update_locked_fret_positions(state, prev_nut_x, frets):
    geom = state["geometry"]
    nut_movement = abs(state["nut_x"] - prev_nut_x)
    nut_stable = nut_movement < NUT_STABILITY_THRESHOLD and len(state["fret_positions"]) > 0

    if nut_stable:
        delta = state["nut_x"] - prev_nut_x
        state["fret_positions"] = [x + delta for x in state["fret_positions"]]
    elif state["nut_x"] > 0 and frets:
        ref_spacing = calculate_first_fret_spacing(geom)
        result = analyze_and_interpolate_frets(state["nut_x"], frets, geom["fret_count"], ref_spacing)
        extended = extend_to_fret_count(result["positions"], geom["fret_count"])
        state["fret_positions"] = smooth_fret_positions(extended, state["fret_positions"])


def update_scale_factor(state, prev_height_scale, fret_wires):
    geom = state["geometry"]
    if not fret_wires or not geom["is_locked"] or geom["nut_height"] == 0:
        return

    total_height = 0
    count = 0
    for fw in fret_wires:
        h = get_polygon_height(fw)
        if h > 10:
            total_height += h
            count += 1

    if count > 0:
        avg_detected = total_height / count
        expected_avg = geom["nut_height"] * (1 + geom["taper_ratio"]) / 2
        scale = avg_detected / expected_avg
        state["height_scale"] = (
            scale if prev_height_scale == 1 else prev_height_scale + (scale - prev_height_scale) * SCALE_SMOOTHING
        )


# ═══════════════════════════════════════════════════
# CALIBRATION STATUS
# ═══════════════════════════════════════════════════

def _build_calibration_status(state):
    geom = state["geometry"]

    if state["is_valid"]:
        status = "locked"
        message = ""
        progress = 100
    elif state["nut_x"] > 0 and state["soundhole_x"] > 0:
        if not geom["is_locked"] and geom["stable_start_time"] > 0:
            elapsed = time.time() * 1000 - geom["stable_start_time"]
            progress = min(100, round(elapsed / GEOMETRY_STABLE_TIME_MS * 100))
            status = "calibrating"
            message = f"Learning geometry... {progress}%"
        else:
            status = "calibrating"
            message = "Detecting fretboard..."
            progress = 0
    elif state["nut_x"] > 0:
        status = "calibrating"
        message = "Looking for soundhole..."
        progress = 0
    elif state["soundhole_x"] > 0:
        status = "calibrating"
        message = "Looking for headstock..."
        progress = 0
    else:
        status = "calibrating"
        message = "Position your guitar in frame"
        progress = 0

    return {
        "status": status,
        "message": message,
        "progress": progress,
        "max_frets_seen": geom["max_frets_seen"],
        "detected_fret_count": len(state["detected_fret_positions"]),
        "detected_nut_y": dict(state["detected_nut_y"]),
        "detected_fret_positions": list(state["detected_fret_positions"]),
    }


# ═══════════════════════════════════════════════════
# MODULE-LEVEL STATE + BLOCK ENTRY POINT
# ═══════════════════════════════════════════════════

_state = {
    "nut_x": 0.0, "nut_center_y": 0.0,
    "soundhole_x": 0.0, "soundhole_center_y": 0.0,
    "axis_angle": 0.0, "height_scale": 1.0,
    "fret_positions": [], "detected_fret_positions": [],
    "detected_nut_y": {"top": 0.0, "bottom": 0.0},
    "is_valid": False,
    "geometry": {
        "nut_height": 0.0, "taper_ratio": 0.75, "fret_count": 0,
        "fretboard_length": 0.0, "scale_length": 0.0,
        "is_locked": False, "stable_start_time": 0.0,
        "last_stable_fret_count": 0, "max_frets_seen": 0, "last_fret_x": 0.0,
    },
}

def run(self, fret_wire_detections, landmark_detections):
    global _state
    state = _state

    # Convert sv.Detections to dicts
    fret_wire_dicts = sv_to_dicts(fret_wire_detections)
    landmark_dicts = sv_to_dicts(landmark_detections)

    prev_nut_x = state["nut_x"]
    prev_height_scale = state["height_scale"]

    detections = classify_detections(landmark_dicts, fret_wire_dicts)
    axis_points = extract_anchors(state, detections)

    if len(axis_points) >= 2:
        angle = fit_line_angle(axis_points)
        state["axis_angle"] = smooth_value(state["axis_angle"], angle, ANGLE_SMOOTHING)

    geom = state["geometry"]
    if geom["is_locked"] and state["nut_x"] > 0 and geom["fretboard_length"] > 0:
        state["soundhole_x"] = state["nut_x"] - geom["fretboard_length"] * math.cos(state["axis_angle"])
        state["soundhole_center_y"] = state["nut_center_y"] - geom["fretboard_length"] * math.sin(
            state["axis_angle"]
        )

    update_scale_factor(state, prev_height_scale, detections["fret_wires"])

    frets = collect_detected_frets(detections["fret_wires"], state["nut_x"], state["soundhole_x"])
    state["detected_fret_positions"] = frets

    if not geom["is_locked"]:
        calibrate_geometry(state, detections, frets)
    else:
        update_locked_fret_positions(state, prev_nut_x, frets)

    state["is_valid"] = (
        state["nut_x"] > 0
        and state["nut_center_y"] > 0
        and geom["is_locked"]
        and len(state["fret_positions"]) > 0
    )

    calibration = _build_calibration_status(state)

    return {
        "geometry_data": {
            "is_valid": state["is_valid"],
            "nut_x": state["nut_x"],
            "nut_center_y": state["nut_center_y"],
            "soundhole_x": state["soundhole_x"],
            "soundhole_center_y": state["soundhole_center_y"],
            "axis_angle": state["axis_angle"],
            "height_scale": state["height_scale"],
            "nut_height": geom["nut_height"],
            "taper_ratio": geom["taper_ratio"],
            "fret_count": geom["fret_count"],
            "fretboard_length": geom["fretboard_length"],
            "fret_positions": list(state["fret_positions"]),
            "calibration": calibration,
        }
    }
