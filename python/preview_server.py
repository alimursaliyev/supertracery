#!/usr/bin/env python3
"""
SuperTracery - SAM2 Preview Server
Persistent stdin/stdout process for interactive segmentation preview.

Usage:
    python3 preview_server.py <frame_path>

Startup: loads image, calls SAM2ImagePredictor.set_image(), prints READY
Query protocol (JSON lines on stdin/stdout):
    Input:  {"x": 320, "y": 240}
    Output: {"bbox": [x1,y1,x2,y2], "polygon": [[x,y],...], "score": 0.92, "centroid": [cx,cy]}
Exit on QUIT or stdin close.
"""

import os
import sys
import json
import numpy as np
import cv2

from tracker import get_sam2_image_predictor, _mask_to_polygon


def main():
    if len(sys.argv) < 2:
        print("ERROR:No frame path provided", flush=True)
        sys.exit(1)

    frame_path = sys.argv[1]
    if not os.path.isfile(frame_path):
        print("ERROR:Frame not found: " + frame_path, flush=True)
        sys.exit(1)

    # Load SAM2 image predictor
    predictor = get_sam2_image_predictor()
    if predictor is None:
        print("ERROR:SAM2 not available", flush=True)
        sys.exit(1)

    # Load and set image
    image = cv2.imread(frame_path)
    if image is None:
        print("ERROR:Could not read image: " + frame_path, flush=True)
        sys.exit(1)

    image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    predictor.set_image(image_rgb)

    print("READY", flush=True)

    # Query loop — read JSON lines from stdin
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        if line == "QUIT":
            break

        try:
            query = json.loads(line)
            x = query["x"]
            y = query["y"]

            point_coords = np.array([[x, y]], dtype=np.float32)
            point_labels = np.array([1], dtype=np.int32)

            pred_masks, scores, _ = predictor.predict(
                point_coords=point_coords,
                point_labels=point_labels,
                multimask_output=True
            )

            best_idx = int(np.argmax(scores))
            mask = pred_masks[best_idx].astype(np.uint8)
            score = round(float(scores[best_idx]), 4)

            # Bounding box
            coords = cv2.findNonZero(mask)
            if coords is not None:
                bx, by, bw, bh = cv2.boundingRect(coords)
                bbox = [int(bx), int(by), int(bx + bw), int(by + bh)]
            else:
                h, w = mask.shape[:2]
                bbox = [0, 0, w, h]

            # Centroid
            moments = cv2.moments(mask)
            if moments["m00"] > 0:
                cx = moments["m10"] / moments["m00"]
                cy = moments["m01"] / moments["m00"]
            else:
                cx, cy = x, y
            centroid = [round(cx, 2), round(cy, 2)]

            # Polygon (simplified for fast transfer)
            polygon = _mask_to_polygon(mask, max_points=32)

            result = {
                "bbox": bbox,
                "polygon": polygon,
                "score": score,
                "centroid": centroid
            }
            print(json.dumps(result), flush=True)

        except Exception as e:
            print(json.dumps({"error": str(e)}), flush=True)


if __name__ == "__main__":
    main()
