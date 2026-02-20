"""
SuperTracery - SAM2 Tracker Wrapper
Handles model loading, segmentation, temporal propagation, and per-frame analysis.
"""

import os
import sys
import json
import glob
import numpy as np
import cv2
from scipy.ndimage import center_of_mass

# Module-level model cache
_model_cache = {}


def _get_device():
    """Detect best available device: CUDA > MPS (Apple Silicon) > CPU."""
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        pass
    return "cpu"


def get_sam2_predictor():
    """Lazy-load SAM2 video predictor with fallback to smaller model."""
    if "predictor" in _model_cache:
        return _model_cache["predictor"]

    device = _get_device()
    print("INFO:Using device: " + device, flush=True)

    try:
        from sam2.sam2_video_predictor import SAM2VideoPredictor

        try:
            predictor = SAM2VideoPredictor.from_pretrained("facebook/sam2-hiera-large", device=device)
            print("INFO:Loaded sam2-hiera-large", flush=True)
        except Exception as e1:
            print("INFO:Large model failed (" + str(e1)[:80] + "), trying small...", flush=True)
            try:
                predictor = SAM2VideoPredictor.from_pretrained("facebook/sam2-hiera-small", device=device)
                print("INFO:Loaded sam2-hiera-small", flush=True)
            except Exception as e2:
                print("INFO:Small model also failed: " + str(e2)[:80], flush=True)
                _model_cache["predictor"] = None
                return None

        _model_cache["predictor"] = predictor
        return predictor

    except ImportError as ie:
        print("INFO:SAM2 not available (" + str(ie) + "), using fallback segmentation", flush=True)
        _model_cache["predictor"] = None
        return None


def get_sam2_image_predictor():
    """Lazy-load SAM2 image predictor for single-frame segmentation."""
    if "image_predictor" in _model_cache:
        return _model_cache["image_predictor"]

    device = _get_device()

    try:
        from sam2.sam2_image_predictor import SAM2ImagePredictor

        try:
            predictor = SAM2ImagePredictor.from_pretrained("facebook/sam2-hiera-large", device=device)
            print("INFO:Loaded SAM2 image predictor (large)", flush=True)
        except Exception:
            try:
                predictor = SAM2ImagePredictor.from_pretrained("facebook/sam2-hiera-small", device=device)
                print("INFO:Loaded SAM2 image predictor (small)", flush=True)
            except Exception as e2:
                print("INFO:SAM2 image predictor failed: " + str(e2)[:80], flush=True)
                _model_cache["image_predictor"] = None
                return None

        _model_cache["image_predictor"] = predictor
        return predictor

    except ImportError:
        _model_cache["image_predictor"] = None
        return None


def load_frames(frames_dir):
    """Load PNG frames from directory, sorted by filename."""
    pattern = os.path.join(frames_dir, "st_frame_*.png")
    paths = sorted(glob.glob(pattern))
    if not paths:
        # AE sometimes appends frame numbers after the extension (e.g. st_frame_00000.png00000)
        pattern = os.path.join(frames_dir, "st_frame_*")
        paths = sorted(glob.glob(pattern))
    if not paths:
        # Try without prefix
        pattern = os.path.join(frames_dir, "*.png")
        paths = sorted(glob.glob(pattern))
    if not paths:
        # Last resort: any file
        pattern = os.path.join(frames_dir, "*")
        paths = sorted(p for p in glob.glob(pattern) if os.path.isfile(p))
    return paths


def segment_single_frame(image_path, click_points):
    """
    Segment objects in a single frame using SAM2 image predictor.
    click_points: list of {"x": int, "y": int, "object_id": int}
    Returns dict of object_id -> binary mask (H, W).
    """
    predictor = get_sam2_image_predictor()
    image = cv2.imread(image_path)
    image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

    masks = {}

    if predictor is not None:
        predictor.set_image(image_rgb)

        for pt in click_points:
            point_coords = np.array([[pt["x"], pt["y"]]], dtype=np.float32)
            point_labels = np.array([1], dtype=np.int32)  # foreground

            pred_masks, scores, _ = predictor.predict(
                point_coords=point_coords,
                point_labels=point_labels,
                multimask_output=True
            )
            # Take highest-scoring mask
            best_idx = np.argmax(scores)
            masks[pt["object_id"]] = pred_masks[best_idx].astype(np.uint8)
    else:
        # Fallback: simple flood-fill based segmentation
        masks = _fallback_segment(image, click_points)

    return masks


def _prepare_sam2_frames(frame_paths):
    """Create a temp directory with SAM2-compatible filenames.
    SAM2's video predictor expects numbered .jpg files (e.g. 00000.jpg).
    Our frames are PNG with non-standard names from AE's render queue.
    We symlink them with the expected naming convention.
    """
    import tempfile
    sam2_dir = tempfile.mkdtemp(prefix="sam2_frames_")
    for i, path in enumerate(frame_paths):
        dst = os.path.join(sam2_dir, "{:05d}.jpg".format(i))
        os.symlink(os.path.abspath(path), dst)
    print("INFO:Prepared {} frames for SAM2 in {}".format(len(frame_paths), sam2_dir), flush=True)
    return sam2_dir


def propagate_masks(frames_dir, frame_paths, initial_masks, click_points):
    """
    Propagate masks across all video frames using SAM2 video predictor.
    initial_masks: dict of object_id -> mask for first frame
    Returns: dict of object_id -> list of masks per frame
    """
    predictor = get_sam2_predictor()
    total_frames = len(frame_paths)

    all_masks = {}
    for obj_id in initial_masks:
        all_masks[obj_id] = [None] * total_frames

    if predictor is not None:
        # SAM2 expects numbered .jpg files — prepare a compatible directory
        sam2_dir = _prepare_sam2_frames(frame_paths)
        inference_state = predictor.init_state(video_path=sam2_dir)

        # Add prompts for each object on the first frame
        for pt in click_points:
            obj_id = pt["object_id"]
            points = np.array([[pt["x"], pt["y"]]], dtype=np.float32)
            labels = np.array([1], dtype=np.int32)

            _, out_obj_ids, out_mask_logits = predictor.add_new_points_or_box(
                inference_state=inference_state,
                frame_idx=0,
                obj_id=obj_id,
                points=points,
                labels=labels
            )

        # Propagate through video
        for frame_idx, obj_ids, mask_logits in predictor.propagate_in_video(inference_state):
            print("PROGRESS:{}/{}".format(frame_idx + 1, total_frames), flush=True)
            for i, obj_id in enumerate(obj_ids):
                mask = (mask_logits[i] > 0.0).cpu().numpy().squeeze().astype(np.uint8)
                if obj_id in all_masks:
                    all_masks[obj_id][frame_idx] = mask

        predictor.reset_state(inference_state)

        # Clean up temp symlink directory
        import shutil
        try:
            shutil.rmtree(sam2_dir)
        except Exception:
            pass
    else:
        # Fallback: optical flow propagation
        all_masks = _fallback_propagate(frame_paths, initial_masks, total_frames)

    return all_masks


def analyze_frame(image_path, mask, prev_centroid=None):
    """
    Compute per-frame analysis for a single object mask.
    Returns dict with centroid, bbox, polygon, area, avg_luma, motion_vector.
    """
    image = cv2.imread(image_path)
    h, w = mask.shape[:2]

    # Centroid
    moments = cv2.moments(mask)
    if moments["m00"] > 0:
        cx = moments["m10"] / moments["m00"]
        cy = moments["m01"] / moments["m00"]
    else:
        cx, cy = w / 2.0, h / 2.0

    centroid = [round(cx, 2), round(cy, 2)]

    # Bounding box
    coords = cv2.findNonZero(mask)
    if coords is not None:
        x1, y1, bw, bh = cv2.boundingRect(coords)
        bbox = [int(x1), int(y1), int(x1 + bw), int(y1 + bh)]
    else:
        bbox = [0, 0, w, h]

    # Area
    area = int(np.sum(mask > 0))

    # Simplified polygon (max 64 points)
    polygon = _mask_to_polygon(mask, max_points=64)

    # Average luminosity within mask
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    masked_pixels = gray[mask > 0]
    if len(masked_pixels) > 0:
        avg_luma = round(float(np.mean(masked_pixels)) / 255.0, 4)
    else:
        avg_luma = 0.0

    # Motion vector
    if prev_centroid is not None:
        motion_vector = [
            round(centroid[0] - prev_centroid[0], 2),
            round(centroid[1] - prev_centroid[1], 2)
        ]
    else:
        motion_vector = [0.0, 0.0]

    return {
        "centroid": centroid,
        "bbox": bbox,
        "polygon": polygon,
        "area": area,
        "avg_luma": avg_luma,
        "motion_vector": motion_vector
    }


def _mask_to_polygon(mask, max_points=64):
    """Convert binary mask to simplified polygon."""
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return []

    # Take largest contour
    contour = max(contours, key=cv2.contourArea)

    # Simplify with increasing epsilon until under max_points
    epsilon = 2.0
    for _ in range(20):
        approx = cv2.approxPolyDP(contour, epsilon, True)
        if len(approx) <= max_points:
            break
        epsilon *= 1.5

    polygon = approx.squeeze().tolist()
    if isinstance(polygon[0], int):
        # Single point edge case
        polygon = [polygon]

    return polygon


def smooth_motion_vectors(frames_data, window=3):
    """Smooth motion vectors with a sliding window average."""
    n = len(frames_data)
    if n < window:
        return frames_data

    half = window // 2
    for i in range(n):
        start = max(0, i - half)
        end = min(n, i + half + 1)
        vx_sum = 0.0
        vy_sum = 0.0
        count = 0
        for j in range(start, end):
            vx_sum += frames_data[j]["motion_vector"][0]
            vy_sum += frames_data[j]["motion_vector"][1]
            count += 1
        if count > 0:
            frames_data[i]["motion_vector"] = [
                round(vx_sum / count, 2),
                round(vy_sum / count, 2)
            ]

    return frames_data


def _fallback_segment(image, click_points):
    """
    Fallback segmentation when SAM2 is not available.
    Uses flood fill from click point with color tolerance.
    """
    masks = {}
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape

    for pt in click_points:
        x = min(max(int(pt["x"]), 0), w - 1)
        y = min(max(int(pt["y"]), 0), h - 1)

        # Flood fill with tolerance
        mask = np.zeros((h + 2, w + 2), np.uint8)
        cv2.floodFill(image.copy(), mask, (x, y), 255, (30, 30, 30), (30, 30, 30),
                       cv2.FLOODFILL_MASK_ONLY | cv2.FLOODFILL_FIXED_RANGE)

        # Crop mask back to image size
        result_mask = mask[1:h + 1, 1:w + 1]

        # Morphological cleanup
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        result_mask = cv2.morphologyEx(result_mask, cv2.MORPH_CLOSE, kernel)
        result_mask = cv2.morphologyEx(result_mask, cv2.MORPH_OPEN, kernel)

        masks[pt["object_id"]] = result_mask

    return masks


def _fallback_propagate(frame_paths, initial_masks, total_frames):
    """
    Fallback temporal propagation using optical flow.
    """
    all_masks = {}
    for obj_id in initial_masks:
        all_masks[obj_id] = [None] * total_frames
        all_masks[obj_id][0] = initial_masks[obj_id]

    prev_gray = cv2.imread(frame_paths[0], cv2.IMREAD_GRAYSCALE)

    for i in range(1, total_frames):
        print("PROGRESS:{}/{}".format(i + 1, total_frames), flush=True)

        curr_gray = cv2.imread(frame_paths[i], cv2.IMREAD_GRAYSCALE)
        if curr_gray is None:
            # Copy previous masks
            for obj_id in all_masks:
                all_masks[obj_id][i] = all_masks[obj_id][i - 1]
            continue

        # Compute dense optical flow
        flow = cv2.calcOpticalFlowFarneback(
            prev_gray, curr_gray, None,
            pyr_scale=0.5, levels=3, winsize=15,
            iterations=3, poly_n=5, poly_sigma=1.2, flags=0
        )

        h, w = prev_gray.shape
        # Create remap grids
        grid_y, grid_x = np.mgrid[0:h, 0:w].astype(np.float32)
        map_x = grid_x + flow[:, :, 0]
        map_y = grid_y + flow[:, :, 1]

        for obj_id in all_masks:
            prev_mask = all_masks[obj_id][i - 1]
            if prev_mask is None:
                all_masks[obj_id][i] = np.zeros((h, w), dtype=np.uint8)
                continue

            # Warp mask with optical flow
            warped = cv2.remap(
                prev_mask.astype(np.float32), map_x, map_y,
                cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0
            )
            all_masks[obj_id][i] = (warped > 0.5).astype(np.uint8)

        prev_gray = curr_gray

    return all_masks
