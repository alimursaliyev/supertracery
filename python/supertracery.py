#!/usr/bin/env python3
"""
SuperTracery - Main Python Entry Point
CLI tool for SAM2-based object segmentation and temporal tracking.

Usage:
    python supertracery.py '<json_config>'

Input JSON:
    {
        "mode": "segment_and_track",
        "frames_dir": "/path/to/frames",
        "click_points": [{"x": 320, "y": 240, "object_id": 0}],
        "output_dir": "/path/to/output",
        "comp_width": 1920,
        "comp_height": 1080
    }

Output: writes results.json to output_dir
Progress: prints PROGRESS:N/TOTAL to stdout
Completion: prints DONE to stdout
Errors: prints ERROR:message to stdout
"""

import os
import sys
import json
import traceback

from tracker import (
    load_frames,
    segment_single_frame,
    propagate_masks,
    analyze_frame,
    smooth_motion_vectors
)


def run_segment_and_track(config):
    """Main pipeline: segment on first frame, propagate, analyze all frames."""
    frames_dir = config["frames_dir"]
    click_points = config["click_points"]
    output_dir = config["output_dir"]
    comp_width = config.get("comp_width", 1920)
    comp_height = config.get("comp_height", 1080)

    # Ensure output dir exists
    os.makedirs(output_dir, exist_ok=True)

    # Load frame paths
    frame_paths = load_frames(frames_dir)
    if not frame_paths:
        print("ERROR:No frames found in {}".format(frames_dir), flush=True)
        return

    total_frames = len(frame_paths)
    print("INFO:Found {} frames".format(total_frames), flush=True)

    # Step 1: Segment first frame
    print("INFO:Segmenting first frame...", flush=True)
    initial_masks = segment_single_frame(frame_paths[0], click_points)

    if not initial_masks:
        print("ERROR:Segmentation produced no masks", flush=True)
        return

    print("INFO:Segmented {} objects".format(len(initial_masks)), flush=True)

    # Step 2: Propagate masks across all frames
    print("INFO:Propagating masks across {} frames...".format(total_frames), flush=True)
    all_masks = propagate_masks(frames_dir, frame_paths, initial_masks, click_points)

    # Step 3: Analyze each frame for each object
    print("INFO:Analyzing frames...", flush=True)
    results = {"objects": []}

    for obj_id in sorted(all_masks.keys()):
        obj_data = {
            "object_id": obj_id,
            "frames": []
        }

        prev_centroid = None
        masks_list = all_masks[obj_id]

        for frame_idx in range(total_frames):
            mask = masks_list[frame_idx]
            if mask is None:
                # No mask for this frame, skip or use empty
                obj_data["frames"].append({
                    "frame_index": frame_idx,
                    "time": round(frame_idx / 30.0, 6),  # approximate
                    "centroid": [comp_width / 2.0, comp_height / 2.0],
                    "bbox": [0, 0, comp_width, comp_height],
                    "polygon": [],
                    "area": 0,
                    "avg_luma": 0.0,
                    "motion_vector": [0.0, 0.0],
                    "confidence": 0.0
                })
                continue

            frame_data = analyze_frame(frame_paths[frame_idx], mask, prev_centroid)
            frame_data["frame_index"] = frame_idx
            frame_data["time"] = round(frame_idx / 30.0, 6)  # will be recalculated by JSX using fps
            frame_data["confidence"] = float(
                min(1.0, frame_data["area"] / max(1, comp_width * comp_height * 0.001))
            )

            prev_centroid = frame_data["centroid"]
            obj_data["frames"].append(frame_data)

            if frame_idx % 10 == 0:
                print("PROGRESS:{}/{}".format(frame_idx + 1, total_frames), flush=True)

        # Smooth motion vectors
        obj_data["frames"] = smooth_motion_vectors(obj_data["frames"], window=3)

        results["objects"].append(obj_data)

    # Write results
    output_path = os.path.join(output_dir, "results.json")
    with open(output_path, "w") as f:
        json.dump(results, f, indent=2)

    print("INFO:Results written to {}".format(output_path), flush=True)
    print("DONE", flush=True)


def run_segment_only(config):
    """Segment a single frame without propagation (for preview)."""
    frames_dir = config["frames_dir"]
    click_points = config["click_points"]
    output_dir = config["output_dir"]

    os.makedirs(output_dir, exist_ok=True)

    frame_paths = load_frames(frames_dir)
    if not frame_paths:
        print("ERROR:No frames found", flush=True)
        return

    masks = segment_single_frame(frame_paths[0], click_points)

    # Save mask previews as PNGs
    for obj_id, mask in masks.items():
        mask_path = os.path.join(output_dir, "mask_{}.png".format(obj_id))
        import cv2
        cv2.imwrite(mask_path, mask * 255)

    print("INFO:Segmentation complete, {} masks saved".format(len(masks)), flush=True)
    print("DONE", flush=True)


def main():
    try:
        if len(sys.argv) < 2:
            print("ERROR:No configuration provided. Pass JSON as first argument.", flush=True)
            sys.exit(1)

        config = json.loads(sys.argv[1])
        mode = config.get("mode", "segment_and_track")

        print("INFO:SuperTracery starting in '{}' mode".format(mode), flush=True)

        if mode == "segment_and_track":
            run_segment_and_track(config)
        elif mode == "segment_only":
            run_segment_only(config)
        else:
            print("ERROR:Unknown mode '{}'".format(mode), flush=True)
            sys.exit(1)

    except json.JSONDecodeError as e:
        print("ERROR:Invalid JSON config: {}".format(str(e)), flush=True)
        sys.exit(1)
    except Exception as e:
        print("ERROR:{}".format(str(e)), flush=True)
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
