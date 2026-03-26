"""
Detection Extractor — Custom Python Block for Roboflow Workflows

Converts sv.Detections (with segmentation masks) to structured JSON
compatible with the client-side PredictionData format.

Pipeline: Model → ByteTracker → Stabilizer → DetectionExtractor → JSON

Stateless — no module-level state, no calibration. All stateful
processing (calibration, smoothing, fret interpolation) is done
client-side to avoid the dual-worker state problem.

Inputs:
  - detections: sv.Detections (tracked + stabilized)

Output:
  - predictions: dict matching client PredictionData format
    {image: {width, height}, predictions: [{class, confidence, points, x, y, width, height}, ...]}
"""

import numpy as np
import cv2


def sv_to_predictions(detections):
    """Convert sv.Detections to prediction dicts with polygon extraction from masks."""
    result = []
    n = len(detections)
    class_names = detections.data.get("class_name", []) if detections.data else []
    confidences = detections.confidence if detections.confidence is not None else []
    class_ids = detections.class_id if detections.class_id is not None else []
    masks = detections.mask

    for i in range(n):
        x1, y1, x2, y2 = detections.xyxy[i]
        w = float(x2 - x1)
        h = float(y2 - y1)
        cx = float((x1 + x2) / 2)
        cy = float((y1 + y2) / 2)

        points = []

        # Extract polygon contour from segmentation mask
        if masks is not None and i < len(masks):
            mask = masks[i].astype(np.uint8)
            contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if contours:
                contour = max(contours, key=cv2.contourArea)
                pts = contour.squeeze()
                if len(pts.shape) == 2 and len(pts) >= 3:
                    points = [{"x": float(p[0]), "y": float(p[1])} for p in pts]

        # Fallback: bbox corners when mask not available
        if not points:
            points = [
                {"x": float(x1), "y": float(y1)},
                {"x": float(x2), "y": float(y1)},
                {"x": float(x2), "y": float(y2)},
                {"x": float(x1), "y": float(y2)},
            ]

        result.append({
            "class": class_names[i] if i < len(class_names) else "",
            "class_id": int(class_ids[i]) if i < len(class_ids) else 0,
            "confidence": float(confidences[i]) if i < len(confidences) else 0,
            "points": points,
            "x": cx,
            "y": cy,
            "width": w,
            "height": h,
        })

    return result


def run(self, detections):
    # Extract image dimensions from masks or bounding boxes
    image_width, image_height = 0, 0
    if detections.mask is not None and len(detections.mask) > 0:
        image_height, image_width = detections.mask[0].shape[:2]
    elif len(detections.xyxy) > 0:
        image_width = int(detections.xyxy[:, 2].max()) + 1
        image_height = int(detections.xyxy[:, 3].max()) + 1

    return {
        "predictions": {
            "image": {"width": image_width, "height": image_height},
            "predictions": sv_to_predictions(detections),
        }
    }
