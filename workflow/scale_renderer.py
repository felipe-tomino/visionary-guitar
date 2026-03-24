"""
Scale + Renderer — Custom Python Block for Roboflow Workflows
Paste this code into a Custom Python block in the guitar-scales workflow.

Inputs:
  - geometry_data: dict from Geometry Engine block
  - image: the original video frame (numpy array)
  - scale_name: string (e.g., "pentatonicMinor")
  - root_note: int (0-11, where 0=C)
  - tuning: string (e.g., "standard")
  - fret_count: int (how many frets to display)

Output:
  - annotated_image: the frame with scale overlay drawn on it
"""

import cv2
import numpy as np
import math

# ═══════════════════════════════════════════════════
# SCALE DEFINITIONS (10 scales)
# ═══════════════════════════════════════════════════

SCALES = {
    "major": {"name": "Major", "intervals": [0, 2, 4, 5, 7, 9, 11]},
    "minor": {"name": "Minor (Natural)", "intervals": [0, 2, 3, 5, 7, 8, 10]},
    "pentatonicMajor": {"name": "Pentatonic Major", "intervals": [0, 2, 4, 7, 9]},
    "pentatonicMinor": {"name": "Pentatonic Minor", "intervals": [0, 3, 5, 7, 10]},
    "blues": {"name": "Blues", "intervals": [0, 3, 5, 6, 7, 10]},
    "harmonicMinor": {"name": "Harmonic Minor", "intervals": [0, 2, 3, 5, 7, 8, 11]},
    "melodicMinor": {"name": "Melodic Minor", "intervals": [0, 2, 3, 5, 7, 9, 11]},
    "dorian": {"name": "Dorian", "intervals": [0, 2, 3, 5, 7, 9, 10]},
    "mixolydian": {"name": "Mixolydian", "intervals": [0, 2, 4, 5, 7, 9, 10]},
    "phrygian": {"name": "Phrygian", "intervals": [0, 1, 3, 5, 7, 8, 10]},
}

# ═══════════════════════════════════════════════════
# TUNING DEFINITIONS (7 tunings, MIDI note numbers)
# ═══════════════════════════════════════════════════

TUNINGS = {
    "standard": {"name": "Standard (EADGBE)", "notes": [40, 45, 50, 55, 59, 64]},
    "dropD": {"name": "Drop D (DADGBE)", "notes": [38, 45, 50, 55, 59, 64]},
    "halfStepDown": {"name": "Half Step Down (Eb)", "notes": [39, 44, 49, 54, 58, 63]},
    "fullStepDown": {"name": "Full Step Down (D)", "notes": [38, 43, 48, 53, 57, 62]},
    "openG": {"name": "Open G (DGDGBD)", "notes": [38, 43, 50, 55, 59, 62]},
    "openD": {"name": "Open D (DADF#AD)", "notes": [38, 45, 50, 54, 57, 62]},
    "dadgad": {"name": "DADGAD", "notes": [38, 45, 50, 55, 57, 62]},
}

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# ═══════════════════════════════════════════════════
# RENDERING CONSTANTS
# ═══════════════════════════════════════════════════

# Colors in BGR for cv2
ROOT_NOTE_COLOR = (107, 107, 255)  # #FF6B6B in BGR
SCALE_NOTE_COLOR = (206, 255, 0)   # #00FFCE in BGR
WHITE = (255, 255, 255)
YELLOW = (0, 215, 255)             # #FFD700 in BGR
CYAN = (206, 255, 0)               # #00FFCE in BGR
RED = (107, 107, 255)              # #FF6B6B in BGR
GRAY = (136, 136, 136)
BLACK_OVERLAY = (0, 0, 0)

NOTE_RADIUS = 14
FONT = cv2.FONT_HERSHEY_SIMPLEX
FONT_SCALE_NOTE = 0.4
FONT_SCALE_STATUS = 0.6
FONT_SCALE_SUB = 0.45
FONT_SCALE_FRET = 0.4
FONT_SCALE_LABEL = 0.35

# Geometry constants
STRING_SPREAD_MARGIN = 0.9
ANGLE_SPREAD_FACTOR = 0.5
FRET_RATIO = 2 ** (-1 / 12)

MARKER_FRETS = [3, 5, 7, 9, 12, 15, 17, 19, 21, 24]


# ═══════════════════════════════════════════════════
# MUSIC THEORY HELPERS
# ═══════════════════════════════════════════════════

def get_note_name(midi_note):
    return NOTE_NAMES[midi_note % 12]


def is_note_in_scale(midi_note, root_note, intervals):
    interval = ((midi_note - root_note) % 12 + 12) % 12
    return interval in intervals


def is_root_note(midi_note, root_note):
    return midi_note % 12 == root_note % 12


# ═══════════════════════════════════════════════════
# GEOMETRY HELPERS
# ═══════════════════════════════════════════════════

def get_height_at_x(geom, nut_x, soundhole_x, x):
    """Get fretboard height at a given X position (linear taper)."""
    nut_height = geom["nut_height"]
    if nut_height == 0:
        return 50

    fretboard_length = nut_x - soundhole_x
    if fretboard_length <= 0:
        return nut_height

    t = max(0, min(1, (nut_x - x) / fretboard_length))
    return nut_height * (1 - t * (1 - geom["taper_ratio"]))


def get_string_position(geom, string_index, string_count, fret_x):
    """Calculate string position at a given fret X, accounting for perspective."""
    nut_x = geom["nut_x"]
    nut_center_y = geom["nut_center_y"]
    soundhole_x = geom["soundhole_x"]
    axis_angle = geom["axis_angle"]
    height_scale = geom["height_scale"]

    # Center point following axis angle
    dx = fret_x - nut_x
    center_y = nut_center_y + dx * math.tan(axis_angle)

    # Width at this position, scaled
    base_width = get_height_at_x(geom, nut_x, soundhole_x, fret_x)
    scaled_width = base_width * height_scale * STRING_SPREAD_MARGIN
    half_width = scaled_width / 2

    # String position within width
    t = string_index / (string_count - 1) if string_count > 1 else 0.5
    offset = -half_width + t * scaled_width

    # Apply axis angle spread
    effective_angle = axis_angle * ANGLE_SPREAD_FACTOR
    perp_x = -math.sin(effective_angle) * offset
    perp_y = math.cos(effective_angle) * offset

    return {"x": fret_x + perp_x, "y": center_y + perp_y}


# ═══════════════════════════════════════════════════
# NOTE POSITION CALCULATION
# ═══════════════════════════════════════════════════

def calculate_note_positions(geom, tuning_key, fret_count_display):
    """Calculate pixel positions for all notes on the fretboard."""
    tuning = TUNINGS.get(tuning_key)
    if not tuning:
        return []

    fret_positions = geom["fret_positions"]
    nut_x = geom["nut_x"]
    string_count = len(tuning["notes"])
    positions = []

    for string_idx in range(string_count):
        open_note = tuning["notes"][string_idx]

        # Open string at nut
        nut_pos = get_string_position(geom, string_idx, string_count, nut_x)
        positions.append({
            "string": string_idx + 1,
            "fret": 0,
            "x": nut_pos["x"],
            "y": nut_pos["y"],
            "note": open_note,
        })

        # Fretted notes
        max_fret = min(fret_count_display, len(fret_positions))
        for fret in range(1, max_fret + 1):
            prev_fret_x = nut_x if fret == 1 else fret_positions[fret - 2]
            mid_fret_x = (prev_fret_x + fret_positions[fret - 1]) / 2
            note_pos = get_string_position(geom, string_idx, string_count, mid_fret_x)
            positions.append({
                "string": string_idx + 1,
                "fret": fret,
                "x": note_pos["x"],
                "y": note_pos["y"],
                "note": open_note + fret,
            })

    return positions


# ═══════════════════════════════════════════════════
# RENDERING FUNCTIONS
# ═══════════════════════════════════════════════════

def draw_note_marker(frame, x, y, note_name, color, is_root, w):
    """Draw a note circle with text at the given position."""
    mx = int(w - x)  # Mirror X
    my = int(y)

    # Semi-transparent circle using overlay
    overlay = frame.copy()
    cv2.circle(overlay, (mx, my), NOTE_RADIUS, color, -1)
    cv2.addWeighted(overlay, 0.5, frame, 0.5, 0, frame)

    # White border for root notes
    if is_root:
        cv2.circle(frame, (mx, my), NOTE_RADIUS, WHITE, 2, cv2.LINE_AA)

    # Note name text
    text_size = cv2.getTextSize(note_name, FONT, FONT_SCALE_NOTE, 1)[0]
    text_x = mx - text_size[0] // 2
    text_y = my + text_size[1] // 2
    cv2.putText(frame, note_name, (text_x, text_y), FONT, FONT_SCALE_NOTE, WHITE, 1, cv2.LINE_AA)


def render_scale_notes(frame, note_positions, scale_intervals, root_note):
    """Draw scale notes on the frame."""
    h, w = frame.shape[:2]

    for pos in note_positions:
        if not is_note_in_scale(pos["note"], root_note, scale_intervals):
            continue

        is_root = is_root_note(pos["note"], root_note)
        color = ROOT_NOTE_COLOR if is_root else SCALE_NOTE_COLOR
        note_name = get_note_name(pos["note"])
        draw_note_marker(frame, pos["x"], pos["y"], note_name, color, is_root, w)


def render_fret_markers(frame, geom, fret_count_display):
    """Draw fret numbers at standard marker positions."""
    fret_positions = geom["fret_positions"]
    nut_x = geom["nut_x"]
    nut_center_y = geom["nut_center_y"]
    nut_height = geom["nut_height"]
    h, w = frame.shape[:2]

    if not fret_positions:
        return

    label_y = int(nut_center_y + nut_height / 2 + 25)

    for fret in range(1, min(fret_count_display, len(fret_positions)) + 1):
        if fret not in MARKER_FRETS:
            continue

        fret_x = fret_positions[fret - 1]
        prev_fret_x = nut_x if fret == 1 else fret_positions[fret - 2]
        center_x = (fret_x + prev_fret_x) / 2

        mx = int(w - center_x)  # Mirror X
        text = str(fret)
        text_size = cv2.getTextSize(text, FONT, FONT_SCALE_FRET, 1)[0]
        cv2.putText(frame, text, (mx - text_size[0] // 2, label_y), FONT, FONT_SCALE_FRET, GRAY, 1, cv2.LINE_AA)


def render_calibration(frame, calibration, geom):
    """Draw calibration visuals: landmarks + status message."""
    h, w = frame.shape[:2]

    nut_x = geom["nut_x"]
    nut_center_y = geom["nut_center_y"]
    soundhole_x = geom["soundhole_x"]
    soundhole_center_y = geom["soundhole_center_y"]
    detected_nut_y = calibration["detected_nut_y"]
    detected_frets = calibration["detected_fret_positions"]

    # Draw detected nut (red vertical line)
    if nut_x > 0 and detected_nut_y["top"] != detected_nut_y["bottom"]:
        mx = int(w - nut_x)
        top = int(detected_nut_y["top"])
        bottom = int(detected_nut_y["bottom"])
        cv2.line(frame, (mx, top), (mx, bottom), RED, 3, cv2.LINE_AA)

        # Label
        text_size = cv2.getTextSize("FRET 0", FONT, FONT_SCALE_LABEL, 1)[0]
        cv2.putText(frame, "FRET 0", (mx - text_size[0] // 2, top - 8), FONT, FONT_SCALE_LABEL, RED, 1, cv2.LINE_AA)

    # Draw detected fret wires (yellow vertical lines)
    if detected_frets and detected_nut_y["top"] != detected_nut_y["bottom"]:
        fret_height = detected_nut_y["bottom"] - detected_nut_y["top"]
        half_h = fret_height / 2

        for i, fret_x in enumerate(detected_frets):
            mx = int(w - fret_x)
            top = int(nut_center_y - half_h)
            bottom = int(nut_center_y + half_h)
            cv2.line(frame, (mx, top), (mx, bottom), YELLOW, 2, cv2.LINE_AA)

            # Fret number label
            text = str(i + 1)
            text_size = cv2.getTextSize(text, FONT, FONT_SCALE_LABEL, 1)[0]
            cv2.putText(frame, text, (mx - text_size[0] // 2, top - 8), FONT, FONT_SCALE_LABEL, YELLOW, 1, cv2.LINE_AA)

    # Draw detected soundhole (cyan circle)
    if soundhole_x > 0:
        mx = int(w - soundhole_x)
        my = int(soundhole_center_y)
        cv2.circle(frame, (mx, my), 20, CYAN, 2, cv2.LINE_AA)

        text_size = cv2.getTextSize("BODY", FONT, FONT_SCALE_LABEL, 1)[0]
        cv2.putText(frame, "BODY", (mx - text_size[0] // 2, my - 30), FONT, FONT_SCALE_LABEL, CYAN, 1, cv2.LINE_AA)

    # Draw status banner
    overlay = frame.copy()
    cv2.rectangle(overlay, (0, 0), (w, 80), BLACK_OVERLAY, -1)
    cv2.addWeighted(overlay, 0.7, frame, 0.3, 0, frame)

    message = calibration["message"]
    text_size = cv2.getTextSize(message, FONT, FONT_SCALE_STATUS, 1)[0]
    cv2.putText(frame, message, (w // 2 - text_size[0] // 2, 35), FONT, FONT_SCALE_STATUS, WHITE, 1, cv2.LINE_AA)

    # Sub-message with fret count
    sub = ""
    if geom["nut_x"] > 0 and geom["soundhole_x"] > 0:
        sub = f"Frets: {calibration['max_frets_seen']} - Hold still"
    elif geom["nut_x"] > 0:
        sub = f"Frets: {calibration['detected_fret_count']} - Show guitar body"
    elif geom["soundhole_x"] > 0:
        sub = "Show the headstock area"

    if sub:
        text_size = cv2.getTextSize(sub, FONT, FONT_SCALE_SUB, 1)[0]
        cv2.putText(frame, sub, (w // 2 - text_size[0] // 2, 60), FONT, FONT_SCALE_SUB, GRAY, 1, cv2.LINE_AA)

    # Draw legend
    legend_x = w - 175
    overlay2 = frame.copy()
    cv2.rectangle(overlay2, (legend_x - 5, 5), (w - 5, 40), BLACK_OVERLAY, -1)
    cv2.addWeighted(overlay2, 0.6, frame, 0.4, 0, frame)

    # Yellow = Detected
    cv2.line(frame, (legend_x, 17), (legend_x + 20, 17), YELLOW, 3)
    cv2.putText(frame, "Detected", (legend_x + 25, 20), FONT, FONT_SCALE_LABEL, WHITE, 1, cv2.LINE_AA)


# ═══════════════════════════════════════════════════
# MAIN ENTRY POINT
# ═══════════════════════════════════════════════════

def run(self, geometry_data, image, scale_name, root_note, tuning, fret_count):
    frame = image.numpy_image.copy() if hasattr(image, "numpy_image") else image.copy()

    is_valid = geometry_data.get("is_valid", False)
    calibration = geometry_data.get("calibration", {})

    if not is_valid:
        # Render calibration visuals
        render_calibration(frame, calibration, geometry_data)
        return {"annotated_image": WorkflowImageData(parent_metadata=image.parent_metadata, numpy_image=frame)}

    # Calculate note positions
    note_positions = calculate_note_positions(geometry_data, tuning, fret_count)

    # Get scale intervals
    scale = SCALES.get(scale_name, SCALES["major"])
    intervals = scale["intervals"]

    # Render fret markers
    render_fret_markers(frame, geometry_data, fret_count)

    # Render scale notes
    render_scale_notes(frame, note_positions, intervals, root_note)

    return {"annotated_image": WorkflowImageData(parent_metadata=image.parent_metadata, numpy_image=frame)}
