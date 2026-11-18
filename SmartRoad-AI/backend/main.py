from typing import List
from pydantic import BaseModel
from fastapi import FastAPI, File, UploadFile, HTTPException, Form, Request, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from ultralytics import YOLO
import cv2
import numpy as np
import os
from datetime import datetime
import base64
import tempfile
import json
import hashlib
import secrets
import uuid
import urllib.request
import io
import zipfile
import threading
from collections import OrderedDict
from starlette.concurrency import run_in_threadpool
from sqlalchemy import create_engine, MetaData, Table, Column, Integer, String, JSON, select, update, func
from sqlalchemy.engine import make_url

# Initialize the app
app = FastAPI(title="SmartRoad API", version="1.0.0")

# Create static directories before mounting them. StaticFiles validates that the
# directory exists during application startup; mounting before creating results
# can prevent the entire FastAPI service from booting on a fresh deployment.
RESULTS_DIR = os.path.join(os.getcwd(), "results")
SOUNDS_DIR = os.path.join(os.getcwd(), "static", "sounds")
os.makedirs(os.path.join(RESULTS_DIR, "images"), exist_ok=True)
os.makedirs(os.path.join(RESULTS_DIR, "videos"), exist_ok=True)
os.makedirs(SOUNDS_DIR, exist_ok=True)

from fastapi.staticfiles import StaticFiles
app.mount("/results", StaticFiles(directory=RESULTS_DIR), name="results")
app.mount("/sounds", StaticFiles(directory=SOUNDS_DIR), name="sounds")

# Add CORS middleware to allow frontend requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load YOLO model
try:
    # Force YOLO to load on CPU to avoid allocating memory for GPU context
    # Use task='detect' and avoid loading half-precision unless specified.
    import torch
    device = "cpu"
    # To reduce memory usage, we disable some heavy caches if possible
    model = YOLO("pothole.pt")
    model.to(device)
except Exception as e:
    print(f"Warning: model loading error: {e}. Using generic yolov8n.pt")
    # yolov8n is ultra-lightweight
    model = YOLO("yolov8n.pt")
    model.to("cpu")
# ================= ADMIN DASHBOARD MEMORY STORAGE =================

# Bounded cache for real outputs from identical image/model inputs.
_IMAGE_DETECTION_CACHE = OrderedDict()
_IMAGE_DETECTION_CACHE_LOCK = threading.Lock()
_IMAGE_MODEL_LOCK = threading.Lock()
_IMAGE_DETECTION_CACHE_MAX = 12


def _cached_image_inspection(image_hash, image_array):
    with _IMAGE_DETECTION_CACHE_LOCK:
        cached = _IMAGE_DETECTION_CACHE.get(image_hash)
        if cached is not None:
            _IMAGE_DETECTION_CACHE.move_to_end(image_hash)
            return cached
    with _IMAGE_MODEL_LOCK:
        detections = detect_potholes(image_array)
        annotated = draw_detections(image_array.copy(), detections)
        encoded = image_to_base64(annotated)
    result = (detections, encoded)
    with _IMAGE_DETECTION_CACHE_LOCK:
        _IMAGE_DETECTION_CACHE[image_hash] = result
        _IMAGE_DETECTION_CACHE.move_to_end(image_hash)
        while len(_IMAGE_DETECTION_CACHE) > _IMAGE_DETECTION_CACHE_MAX:
            _IMAGE_DETECTION_CACHE.popitem(last=False)
    return result


dashboard_data = {
    "total_uploads": 0,
    "total_detections": 0,
    "minor": 0,
    "moderate": 0,
    "major": 0,
    "reports": []
}

# Persistent complaint storage.
# Configure DATABASE_URL with a managed PostgreSQL database in production
# (Render PostgreSQL). SQLite is retained for local development only.
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./smartroad_local.db")
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql+psycopg://", 1)
elif DATABASE_URL.startswith("postgresql://"):
    DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+psycopg://", 1)

_db_connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
db_engine = create_engine(DATABASE_URL, pool_pre_ping=True, connect_args=_db_connect_args)
db_metadata = MetaData()
complaints_table = Table(
    "smartroad_complaints",
    db_metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("uploader_id", String(128), index=True),
    Column("created_at", String(40), index=True),
    Column("payload", JSON, nullable=False),
)
users_table = Table(
    "smartroad_users",
    db_metadata,
    Column("user_id", String(128), primary_key=True),
    Column("payload", JSON, nullable=False),
)
db_metadata.create_all(db_engine)


def load_persisted_reports():
    with db_engine.connect() as connection:
        rows = connection.execute(
            select(complaints_table.c.payload).order_by(complaints_table.c.id.asc())
        ).scalars().all()
    return [dict(row) for row in rows]


def _road_segment_id(lat, lng):
    """Create a stable location-derived segment key; it is not an official road registry ID."""
    if lat is None or lng is None:
        return None
    return f"SRD-{round(float(lat), 4):+.4f}-{round(float(lng), 4):+.4f}"


def _find_duplicate_master(report, radius_m=35):
    """Link nearby active pothole reports while preserving every citizen's own complaint."""
    if int(report.get("detections", 0) or 0) <= 0:
        return None, None
    try:
        lat, lng = float(report.get("lat")), float(report.get("lng"))
    except (TypeError, ValueError):
        return None, None
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return None, None

    from math import radians, sin, cos, asin, sqrt
    # Read from the database rather than process memory so reports created by
    # another API worker are included in duplicate checks.
    for existing in load_persisted_reports():
        if int(existing.get("detections", 0) or 0) <= 0:
            continue
        if str(existing.get("status", "")).lower() in {
            "completed", "resolved", "closed", "rejected", "false image/rejected", "pending submission"
        }:
            continue
        try:
            old_lat, old_lng = float(existing.get("lat")), float(existing.get("lng"))
        except (TypeError, ValueError):
            continue
        dlat, dlng = radians(lat - old_lat), radians(lng - old_lng)
        a = sin(dlat / 2) ** 2 + cos(radians(old_lat)) * cos(radians(lat)) * sin(dlng / 2) ** 2
        distance = 6371000 * 2 * asin(sqrt(a))
        if distance <= radius_m:
            master_id = existing.get("duplicate_of") or existing.get("id")
            master = next(
                (item for item in dashboard_data.get("reports", []) if str(item.get("id")) == str(master_id)),
                existing,
            )
            return master, round(distance, 1)
    return None, None


def persist_report(report):
    """Persist a complaint, assign a road segment key and link nearby active reports."""
    payload = dict(report)
    payload.pop("id", None)
    payload["road_segment_id"] = payload.get("road_segment_id") or _road_segment_id(
        payload.get("lat"), payload.get("lng")
    )
    master, duplicate_distance = _find_duplicate_master(payload)
    if master:
        payload["duplicate_group_id"] = master.get("duplicate_group_id") or f"DUP-{master.get('id')}"
        payload["duplicate_of"] = master.get("id")
        payload["duplicate_match_distance_m"] = duplicate_distance
    else:
        payload["duplicate_of"] = None

    with db_engine.begin() as connection:
        result = connection.execute(
            complaints_table.insert().values(
                uploader_id=str(payload.get("uploader_id") or ""),
                created_at=str(payload.get("timestamp") or datetime.now().isoformat()),
                payload=payload,
            )
        )
        report_id = result.inserted_primary_key[0]
        payload["id"] = report_id
        if not master and int(payload.get("detections", 0) or 0) > 0 and payload.get("lat") is not None:
            payload["duplicate_group_id"] = f"DUP-{report_id}"
        connection.execute(
            complaints_table.update()
            .where(complaints_table.c.id == report_id)
            .values(payload=payload)
        )

        if master:
            linked_ids = list(master.get("linked_report_ids") or [])
            if report_id not in linked_ids:
                linked_ids.append(report_id)
            master["duplicate_group_id"] = payload["duplicate_group_id"]
            master["linked_report_ids"] = linked_ids
            master["duplicate_count"] = len(linked_ids) + 1
            connection.execute(
                complaints_table.update()
                .where(complaints_table.c.id == int(master["id"]))
                .values(payload=master)
            )
    return payload


def update_persisted_report(report_id, changes):
    """Update a complaint's JSON payload without losing its other fields."""
    with db_engine.begin() as connection:
        row = connection.execute(
            select(complaints_table.c.payload).where(complaints_table.c.id == report_id)
        ).first()
        if not row:
            return None
        payload = dict(row[0])
        payload.update(changes)
        connection.execute(
            complaints_table.update()
            .where(complaints_table.c.id == report_id)
            .values(
                uploader_id=str(payload.get("uploader_id") or ""),
                created_at=str(payload.get("timestamp") or ""),
                payload=payload,
            )
        )
    return payload


# Restore reports after every process restart/deployment.
dashboard_data["reports"] = load_persisted_reports()


# Ensure results folders exist
os.makedirs(os.path.join(os.getcwd(), "results", "images"), exist_ok=True)
os.makedirs(os.path.join(os.getcwd(), "results", "videos"), exist_ok=True)

# Helper function to classify severity based on area
def classify_severity(area):
    if area < 5000:
        return "Minor"
    elif area < 20000:
        return "Moderate"
    else:
        return "Major"

# Helper function to get color based on severity
def get_severity_color(severity):
    colors = {
        "Minor": (0, 255, 0),      # Green
        "Moderate": (0, 255, 255),  # Yellow
        "Major": (0, 0, 255)        # Red
    }
    return colors.get(severity, (0, 255, 0))

# Helper function to detect potholes in frame/image
def detect_potholes(image_array):
    """Run YOLO detection on image and return results"""
    results = model(image_array)
    detections = []
    # Allowed class names for potholes (update if your model uses a different label)
    ALLOWED_CLASSES = {"pothole", "potholes"}
   
    for r in results:
        # r.names maps class indices to names for this result/model
        names_map = getattr(r, 'names', None) or getattr(model, 'names', {})

        for box in r.boxes:
            # optional: check predicted class if available
            class_id = None
            try:
                class_id = int(box.cls[0])
            except Exception:
                class_id = None

            class_name = None
            if class_id is not None and names_map is not None:
                class_name = names_map.get(class_id, None)

            # Require a class name and skip if it's not a pothole
            if not class_name or class_name.lower() not in ALLOWED_CLASSES:
                continue

            x1, y1, x2, y2 = box.xyxy[0]
            conf = float(box.conf[0])

            x1, y1, x2, y2 = int(x1), int(y1), int(x2), int(y2)

            # Calculate area
            width = x2 - x1
            height = y2 - y1
            area = width * height

            severity = classify_severity(area)

            detections.append({
                "bbox": [x1, y1, x2, y2],
                "confidence": round(conf, 2),
                "area": area,
                "severity": severity,
                "severity_basis": "bounding_box_pixel_area_heuristic",
                "review_required": conf < 0.50,
                "width": width,
                "height": height
            })
   
    return detections

# Helper function to draw detections on image
def draw_detections(image, detections):
    """Draw bounding boxes and labels on image"""
    for detection in detections:
        x1, y1, x2, y2 = detection["bbox"]
        severity = detection["severity"]
        conf = detection["confidence"]
       
        color = get_severity_color(severity)
       
        # Draw bounding box
        cv2.rectangle(image, (x1, y1), (x2, y2), color, 2)
       
        # Put label
        label = f"{severity} ({conf:.2f})"
        cv2.putText(image, label, (x1, y1 - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
   
    return image

# Helper function to convert image to base64
def image_to_base64(image_array):
    """Convert numpy array to base64 string"""
    _, buffer = cv2.imencode('.jpg', image_array)
    return base64.b64encode(buffer).decode('utf-8')


def parse_coords_from_string(s):
    """Try to parse latitude and longitude from a free-form string.
    Returns (lat, lng) as floats or (None, None) if not found.
    """
    if not s or not isinstance(s, str):
        return None, None
    import re
    # find sequences that look like floats (with optional sign and decimals)
    nums = re.findall(r"[-+]?[0-9]*\.?[0-9]+", s)
    if len(nums) >= 2:
        try:
            a = float(nums[0])
            b = float(nums[1])
            # Heuristic: lat must be between -90 and 90, lng between -180 and 180
            if -90 <= a <= 90 and -180 <= b <= 180:
                return a, b
            if -90 <= b <= 90 and -180 <= a <= 180:
                return b, a
        except Exception:
            return None, None
    return None, None


# ----------------- Simple user store -----------------
USERS_FILE = os.path.join(os.getcwd(), "users.json")

def load_users():
    """Load users from the database, importing the legacy JSON file once."""
    with db_engine.connect() as connection:
        rows = connection.execute(select(users_table.c.payload)).scalars().all()
    if rows:
        return [dict(row) for row in rows]

    # One-time migration for accounts created before database persistence.
    legacy_users = []
    try:
        with open(USERS_FILE, "r", encoding="utf-8") as f:
            legacy_users = json.load(f) or []
    except (OSError, ValueError, TypeError):
        legacy_users = []

    if legacy_users:
        save_users(legacy_users)
        return legacy_users
    return []

def save_users(users):
    """Persist the user collection so account tokens survive service restarts."""
    with db_engine.begin() as connection:
        connection.execute(users_table.delete())
        if users:
            connection.execute(users_table.insert(), [
                {"user_id": str(user.get("id") or uuid.uuid4().hex), "payload": user}
                for user in users
            ])


def find_user_by_token(token: str):
    if not token:
        return None
    users = load_users()
    for u in users:
        if u.get('token') == token:
            return u
    return None


def credit_user_by_token(token: str, coins: int, meta: dict = None):
    if not token or coins <= 0:
        return None
    users = load_users()
    for u in users:
        if u.get('token') == token:
            u['coins'] = int(u.get('coins', 0)) + int(coins)
            uploads = u.get('uploads') or []
            entry = {
                'id': uuid.uuid4().hex,
                'timestamp': datetime.now().isoformat(),
                'coins': int(coins),
                'meta': meta or {}
            }
            uploads.append(entry)
            u['uploads'] = uploads
            save_users(users)
            return u
    return None

def hash_password(password, salt=None):
    if salt is None:
        salt = secrets.token_hex(16)
    pwd = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), 100000)
    return salt, pwd.hex()

def verify_password(password, salt, pwd_hash):
    _, h = hash_password(password, salt)
    return h == pwd_hash

# Create users file if missing
if not os.path.exists(USERS_FILE):
    save_users([])

# ============== ROOT ENDPOINTS ==============

@app.get("/")
def read_root():
    return {
        "message": "SmartRoad Backend API",
        "version": "1.0.0",
        "endpoints": {
            "demo": "/demo",
            "detect_image": "/detect/image",
            "detect_video": "/detect/video",
            "health": "/health",
            "my_complaints": "/user/complaints"
        }
    }

@app.get("/demo")
def read_demo():
    """Demo endpoint"""
    return {
        "success": True,
        "message": "SmartRoad Backend is working!",
        "data": {
            "timestamp": datetime.now().isoformat(),
            "status": "Backend API is connected",
            "serverInfo": {
                "name": "SmartRoad Backend",
                "version": "1.0.0",
                "type": "FastAPI"
            }
        }
    }

@app.get("/health")
def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "model_loaded": model is not None,
        "timestamp": datetime.now().isoformat()
    }

# ============== IMAGE DETECTION ENDPOINTS ==============

@app.post("/detect/image")
async def detect_image(
    file: UploadFile = File(...),
    latitude: str = Form(None),
    longitude: str = Form(None),
    description: str = Form(None),
    road_name: str = Form(None),
    is_critical: str = Form(None),
    token: str = Form(None),
    request: Request = None,
):
    """
    Detect potholes in uploaded image
   
    Returns:
    - detections: List of detected potholes with coordinates and severity
    - image_with_detections: Base64 encoded image with drawn detections
    - statistics: Summary of detections
    """
   
    try:
        # Pre-initialize so `del image` never causes UnboundLocalError
        image = None
        nparr = None
        image_height = 0
        image_width = 0

        # Read and validate the upload before inference or disk writes.
        contents = await file.read()
        if not contents:
            raise HTTPException(status_code=400, detail="The uploaded image is empty.")
        if len(contents) > 10 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Image exceeds the 10 MB upload limit.")
        nparr = np.frombuffer(contents, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        # Free raw bytes early to save memory
        del nparr
        nparr = None

        if image is None:
            raise HTTPException(status_code=400, detail="Invalid image file - could not decode")
        if image.shape[0] < 64 or image.shape[1] < 64:
            raise HTTPException(status_code=400, detail="Image is too small for reliable road inspection (minimum 64 x 64 pixels).")

        # Save only validated uploads; preserve a static URL for report previews.
        extension = os.path.splitext(file.filename or "")[1].lower()
        if extension not in {".jpg", ".jpeg", ".png", ".webp"}:
            extension = ".jpg"
        fname = f"{uuid.uuid4().hex}{extension}"
        save_path = os.path.join(RESULTS_DIR, "images", fname)
        with open(save_path, "wb") as output_file:
            output_file.write(contents)
        image_url = f"/results/images/{fname}"
        image_hash = hashlib.sha256(contents).hexdigest()
        del contents

        # Cache dimensions before any resizing
        image_height = image.shape[0]
        image_width = image.shape[1]

        # Downscale large images to reduce peak RAM during YOLO inference
        MAX_DIM = 800
        h, w = image.shape[:2]
        if max(h, w) > MAX_DIM:
            scale = MAX_DIM / max(h, w)
            image = cv2.resize(image, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)

        # Keep CPU-bound model inference and JPEG encoding off the async event loop.
        detections, image_base64 = await run_in_threadpool(_cached_image_inspection, image_hash, image)
        del image
        image = None

        # Calculate statistics
        severity_count = {
            "Minor": len([d for d in detections if d["severity"] == "Minor"]),
            "Moderate": len([d for d in detections if d["severity"] == "Moderate"]),
            "Major": len([d for d in detections if d["severity"] == "Major"])
        }
        # ================= UPDATE ADMIN DASHBOARD =================

        dashboard_data["total_uploads"] += 1
        dashboard_data["total_detections"] += len(detections)
        dashboard_data["minor"] += severity_count["Minor"]
        dashboard_data["moderate"] += severity_count["Moderate"]
        dashboard_data["major"] += severity_count["Major"]

        # Build report entry including location if provided
        try:
            lat = float(latitude) if latitude not in (None, "") else None
        except Exception:
            lat = None
        try:
            lng = float(longitude) if longitude not in (None, "") else None
        except Exception:
            lng = None

        # If lat/lng not provided, attempt to parse from description (or free-form location text)
        if (lat is None or lng is None) and description:
            p_lat, p_lng = parse_coords_from_string(description)
            if p_lat is not None and p_lng is not None:
                lat, lng = p_lat, p_lng

        # Reject out-of-range GPS values and require a complete coordinate pair.
        if lat is not None and not -90 <= lat <= 90:
            lat = None
        if lng is not None and not -180 <= lng <= 180:
            lng = None
        if lat is None or lng is None:
            lat, lng = None, None

        # Prefer coordinates for location when available; keep original description separately.
        location_str = f"{lat},{lng}" if lat is not None and lng is not None else (description or "Unknown Road")
        road_segment_id = _road_segment_id(lat, lng)

        # Resolve uploader from token (form token or Authorization header)
        auth_token = token
        if not auth_token and request is not None:
            auth_hdr = request.headers.get('authorization') or request.headers.get('Authorization')
            if auth_hdr and isinstance(auth_hdr, str) and auth_hdr.lower().startswith('bearer '):
                auth_token = auth_hdr.split(' ', 1)[1].strip()

        uploader = None
        try:
            uploader = find_user_by_token(auth_token) if auth_token else None
        except Exception:
            uploader = None

        report = {
            "id": None,
            "type": "image",
            "source": "user",
            "location": location_str,
            "road_name": road_name or None,
            "description": description,
            "ai_summary": (f"AI analysis identified {len(detections)} pothole(s): {severity_count['Major']} major, {severity_count['Moderate']} moderate and {severity_count['Minor']} minor damage instance(s). " + ("Inspection and necessary road maintenance are requested." if detections else "No potholes were detected by the AI model; manual inspection may still be requested.")),
            "status": "Pending Submission",
            "submission_status": "draft",
            "progress": 0,
            "detections": len(detections),
            "detection_details": detections,
            "damage_type": "Pothole" if detections else "No damage detected",
            "priority": "Critical" if str(is_critical).lower() in {"true", "1", "yes"} else ("Major" if severity_count["Major"] else "Moderate" if severity_count["Moderate"] else "Minor" if severity_count["Minor"] else "No detected damage"),
            "severity": severity_count,
            "timestamp": datetime.now().isoformat(),
            "lat": lat,
            "lng": lng,
            "road_segment_id": road_segment_id,
            "location_resolution": "GPS supplied" if lat is not None and lng is not None else "Manual location; GPS unavailable",
            "image_path": save_path,
            "image_url": image_url,
            "original_file_name": file.filename or "uploaded-road-image",
            "image_with_detections": image_base64,
            # Account details are sourced from the authenticated profile only.
            "uploader_id": uploader.get('id') if uploader else None,
            "uploader_name": uploader.get('name') if uploader else "Anonymous",
            "uploader_email": uploader.get('email') if uploader else None,
            "uploader_phone": uploader.get('phone') if uploader else None,
            "verified": bool(uploader),
            "ai_review_required": any(d.get("review_required") for d in detections),
            "severity_method": "bounding_box_pixel_area_heuristic_not_physical_measurement",
        }

        # Detection is saved as a draft in the existing table. It is not yet
        # an official complaint and is hidden from citizen/admin complaint lists.
        if len(detections) == 0:
            report["note"] = "No potholes detected in the submitted image."
        report = persist_report(report)
        return {
            "success": True,
            "message": "No potholes detected" if no_potholes else "Image detection completed",
            "no_potholes": no_potholes,
            "detections": detections,
            "image_with_detections": image_base64,
            "statistics": {
                "total_detections": len(detections),
                "severity_breakdown": severity_count,
                "image_height": image_height,
                "image_width": image_width
            },
            "complaint": {
                "id": report.get("id"),
                "road_segment_id": report.get("road_segment_id"),
                "duplicate_group_id": report.get("duplicate_group_id"),
                "duplicate_of": report.get("duplicate_of"),
                "status": report.get("status"),
                "submission_status": "draft",
                "timestamp": report.get("timestamp"),
            },
            "report": {k: v for k, v in report.items() if k != "image_path"},
            "timestamp": datetime.now().isoformat()
        }
   
    except HTTPException:
        raise
    except Exception as e:
        # Avoid unbound errors if image wasn't created
        try:
            if 'image' in locals() and image is not None:
                del image
            if 'nparr' in locals() and nparr is not None:
                del nparr
            import gc
            gc.collect()
        except Exception: 
            pass

        raise HTTPException(status_code=500, detail=str(e))


@app.post("/detect/url-image")
async def detect_image_from_url(body: dict = Body(...), request: Request = None):
    """Fetch an image from a remote URL and run detection."""
    try:
        image_url = body.get('image_url') if isinstance(body, dict) else None
        if not image_url:
            raise HTTPException(status_code=400, detail="image_url is required")

        # Download image bytes
        try:
            with urllib.request.urlopen(image_url, timeout=15) as resp:
                contents = resp.read()
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to download image: {str(e)}")

        image = None
        nparr = None
        image_height = 0
        image_width = 0

        nparr = np.frombuffer(contents, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if image is None:
            raise HTTPException(status_code=400, detail="Downloaded file is not a valid image")

        detections = detect_potholes(image)
        image_with_detections = draw_detections(image.copy(), detections)
        image_base64 = image_to_base64(image_with_detections)

        # Cache dimensions before GC cleanup
        image_height = image.shape[0]
        image_width = image.shape[1]

        # Manual garbage collection to prevent memory ballooning on 512MB Render instances
        import gc
        del image
        del nparr
        image = None
        nparr = None
        gc.collect()

        severity_count = {
            "Minor": len([d for d in detections if d["severity"] == "Minor"]),
            "Moderate": len([d for d in detections if d["severity"] == "Moderate"]),
            "Major": len([d for d in detections if d["severity"] == "Major"])
        }

        return {
            "success": True,
            "message": "Image detection completed",
            "detections": detections,
            "image_with_detections": image_base64,
            "statistics": {
                "total_detections": len(detections),
                "severity_breakdown": severity_count,
                "image_height": image_height,
                "image_width": image_width
            },
            "timestamp": datetime.now().isoformat()
        }

    except HTTPException:
        raise
    except Exception as e:
        try:
            if 'image' in locals() and image is not None:
                del image
            if 'nparr' in locals() and nparr is not None:
                del nparr
            import gc
            gc.collect()
        except: pass
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/detect/batch")
async def detect_batch(
    file: UploadFile = File(None),
    zip_url: str = Form(None)
):
    """Process a batch ZIP (uploaded file or remote zip URL). Returns per-image results and a summary."""
    try:
        # Read zip bytes from upload or URL
        if file is not None:
            contents = await file.read()
        elif zip_url:
            try:
                with urllib.request.urlopen(zip_url, timeout=30) as resp:
                    contents = resp.read()
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"Failed to download zip: {str(e)}")
        else:
            raise HTTPException(status_code=400, detail="Provide an uploaded zip file or zip_url")

        # Open zip
        try:
            zf = zipfile.ZipFile(io.BytesIO(contents))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid ZIP archive: {str(e)}")

        image_files = [n for n in zf.namelist() if n.lower().endswith(('.jpg', '.jpeg', '.png'))]
        results = []
        max_process = 200
        processed = 0

        for name in image_files:
            if processed >= max_process:
                break
            try:
                data = zf.read(name)
                nparr = np.frombuffer(data, np.uint8)
                image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                if image is None:
                    continue

                detections = detect_potholes(image)
                annotated = draw_detections(image.copy(), detections)
                annotated_b64 = image_to_base64(annotated)

                # Cache shape before GC
                image_width = image.shape[1]
                image_height = image.shape[0]

                import gc
                del image
                del nparr
                gc.collect()

                results.append({
                    'filename': name,
                    'detections': detections,
                    'image_with_detections': annotated_b64,
                    'statistics': {
                        'total_detections': len(detections),
                        'image_width': image_width,
                        'image_height': image_height
                    }
                })
                processed += 1
            except Exception:
                continue

        summary = {
            'processed': processed,
            'total_files_in_zip': len(image_files),
            'successful': len(results)
        }

        return {
            'success': True,
            'summary': summary,
            'results': results,
            'timestamp': datetime.now().isoformat()
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Batch processing error: {str(e)}")

# ============== VIDEO DETECTION ENDPOINTS ==============

@app.post("/detect/video")
async def detect_video(
    file: UploadFile = File(...),
    latitude: str = Form(None),
    longitude: str = Form(None),
    description: str = Form(None),
    road_name: str = Form(None),
    is_critical: str = Form(None),
    token: str = Form(None),
    request: Request = None,
):
    """
    Detect potholes in uploaded video
    Processes frames and deduplicates similar detections across frames
   
    Returns:
    - detections: Unique potholes detected
    - statistics: Summary statistics
    """
   
    try:
        # Create a unique report id and artifact directory for provenance/evidence
        report_id = uuid.uuid4().hex
        artifacts_dir = os.path.join(os.getcwd(), "results", "artifacts", report_id)
        os.makedirs(artifacts_dir, exist_ok=True)
        os.makedirs(os.path.join(artifacts_dir, "thumbs"), exist_ok=True)

        # Read and validate the video before writing it to disk.
        contents = await file.read()
        if not contents:
            raise HTTPException(status_code=400, detail="The uploaded video is empty.")
        if len(contents) > 100 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Video exceeds the 100 MB upload limit.")
        with tempfile.NamedTemporaryFile(delete=False, suffix=".mp4") as tmp_file:
            tmp_file.write(contents)
            tmp_path = tmp_file.name

        # Also persist a copy to results/videos
        try:
            extension = os.path.splitext(file.filename or "")[1].lower()
            if extension not in {".mp4", ".mov", ".avi", ".mkv", ".webm"}:
                extension = ".mp4"
            vname = f"{uuid.uuid4().hex}{extension}"
            save_vpath = os.path.join(os.getcwd(), "results", "videos", vname)
            with open(save_vpath, "wb") as vf:
                vf.write(contents)
        except Exception:
            save_vpath = None
        # Also save a copy into artifacts for provenance
        try:
            art_orig = os.path.join(artifacts_dir, "original.mp4")
            with open(art_orig, "wb") as af:
                af.write(contents)
        except Exception:
            art_orig = None
       
        # Open video
        cap = cv2.VideoCapture(tmp_path)
       
        if not cap.isOpened():
            raise HTTPException(status_code=400, detail="Invalid video file")
       
        fps = cap.get(cv2.CAP_PROP_FPS)
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
       
        frame_count = 0
        processed_frames = 0
        all_detections = []
        max_detections_per_frame = 0
        # Prepare annotated video writer (write resized frames as processed)
        annotated_tmp = os.path.join(artifacts_dir, "annotated.mp4")
        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        writer = cv2.VideoWriter(annotated_tmp, fourcc, max(1.0, fps or 10.0), (640, 480))

        # Per-frame log for provenance
        per_frame_logs = []
       
        while True:
            ret, frame = cap.read()
            if not ret:
                break
           
            frame_count += 1
           
            # Process every 3rd frame for performance (reduces redundant detections)
            if frame_count % 3 != 0:
                continue
           
            processed_frames += 1
           
            # Resize frame for faster processing
            frame = cv2.resize(frame, (640, 480))
           
            # Detect potholes in this frame
            frame_detections = detect_potholes(frame)

            # Draw detections on a copy and write to annotated video for evidence
            try:
                annotated_frame = draw_detections(frame.copy(), frame_detections)
            except Exception:
                annotated_frame = frame
            try:
                writer.write(annotated_frame)
            except Exception:
                pass

            # Add entry(s) to per-frame log
            if frame_detections:
                max_detections_per_frame = max(max_detections_per_frame, len(frame_detections))
                # attach frame reference and frame_index to each detection for preview generation
                for det in frame_detections:
                    det['frame'] = frame.copy()
                    det['frame_index'] = frame_count
                all_detections.extend(frame_detections)
                try:
                    entry = {"frame_index": frame_count, "detections": []}
                    for fd in frame_detections:
                        entry["detections"].append({
                            "bbox": fd.get("bbox"),
                            "confidence": fd.get("confidence"),
                            "area": fd.get("area"),
                            "severity": fd.get("severity"),
                        })
                    per_frame_logs.append(entry)
                except Exception:
                    pass
            
            # Manual GC to prevent memory overflow on 512MB RAM instances
            import gc
            del frame
            del annotated_frame
            gc.collect()
       
        cap.release()
        try:
            writer.release()
        except Exception:
            pass
       
        # Clean up temporary file
        os.unlink(tmp_path)
       
        # Deduplicate detections - assume similar boxes in consecutive frames are same pothole
        # Group by approximate location and take average
        unique_detections = []
        used_indices = set()
       
        # Helper to create a cropped, annotated thumbnail from a frame and bbox
        def frame_crop_base64(frame_img, bbox, padding=12, max_width=640):
            h, w = frame_img.shape[:2]
            x1, y1, x2, y2 = bbox
            x1 = max(0, x1 - padding)
            y1 = max(0, y1 - padding)
            x2 = min(w, x2 + padding)
            y2 = min(h, y2 + padding)
            crop = frame_img[y1:y2, x1:x2]
            if crop.size == 0:
                return None
            # draw bbox relative to crop
            rel_bbox = [padding, padding, (x2 - x1) - padding, (y2 - y1) - padding]
            try:
                crop_annot = draw_detections(crop.copy(), [{"bbox": [0, 0, crop.shape[1], crop.shape[0]], "severity": classify_severity((crop.shape[1]*crop.shape[0])), "confidence": 1.0}])
            except Exception:
                crop_annot = crop
            _, buffer = cv2.imencode('.jpg', crop_annot)
            return base64.b64encode(buffer).decode('utf-8')

        for i, det1 in enumerate(all_detections):
            if i in used_indices:
                continue
           
            # Start a cluster with this detection
            cluster = [det1]
            used_indices.add(i)
           
            x1_1, y1_1, x2_1, y2_1 = det1["bbox"]
            center_x1 = (x1_1 + x2_1) / 2
            center_y1 = (y1_1 + y2_1) / 2
           
            # Find similar detections nearby
            for j, det2 in enumerate(all_detections[i+1:], start=i+1):
                if j in used_indices:
                    continue
               
                x1_2, y1_2, x2_2, y2_2 = det2["bbox"]
                center_x2 = (x1_2 + x2_2) / 2
                center_y2 = (y1_2 + y2_2) / 2
               
                # If centers are close (within 50 pixels), consider them same pothole
                distance = ((center_x1 - center_x2) ** 2 + (center_y1 - center_y2) ** 2) ** 0.5
                if distance < 50:
                    cluster.append(det2)
                    used_indices.add(j)
           
            # Average the cluster to get final detection
            avg_x1 = sum(d["bbox"][0] for d in cluster) / len(cluster)
            avg_y1 = sum(d["bbox"][1] for d in cluster) / len(cluster)
            avg_x2 = sum(d["bbox"][2] for d in cluster) / len(cluster)
            avg_y2 = sum(d["bbox"][3] for d in cluster) / len(cluster)
            avg_conf = sum(d["confidence"] for d in cluster) / len(cluster)
           
            width = avg_x2 - avg_x1
            height = avg_y2 - avg_y1
            area = width * height
            severity = classify_severity(area)
           
            # choose representative detection for preview (first in cluster)
            rep = cluster[0]
            rep_frame = rep.get('frame', None)

            # build preview image for this cluster if we have a frame
            preview_b64 = None
            if rep_frame is not None:
                try:
                    preview_b64 = frame_crop_base64(rep_frame, [int(avg_x1), int(avg_y1), int(avg_x2), int(avg_y2)])
                except Exception:
                    preview_b64 = None

            unique_detections.append({
                "bbox": [int(avg_x1), int(avg_y1), int(avg_x2), int(avg_y2)],
                "confidence": round(avg_conf, 2),
                "area": int(area),
                "severity": severity,
                "width": int(width),
                "height": int(height),
                "occurrences": len(cluster),  # How many frames this pothole appeared in
                "preview_image": preview_b64,
                "frame_index": rep.get('frame_index', None),
                "sample_description": description
            })
       
        # Calculate statistics
        severity_count = {
            "Minor": len([d for d in unique_detections if d["severity"] == "Minor"]),
            "Moderate": len([d for d in unique_detections if d["severity"] == "Moderate"]),
            "Major": len([d for d in unique_detections if d["severity"] == "Major"])
        }
        # ================= UPDATE ADMIN DASHBOARD =================

        dashboard_data["total_uploads"] += 1
        dashboard_data["total_detections"] += len(unique_detections)
        dashboard_data["minor"] += severity_count["Minor"]
        dashboard_data["moderate"] += severity_count["Moderate"]
        dashboard_data["major"] += severity_count["Major"]

        # Build report entry including location if provided
        try:
            lat = float(latitude) if latitude not in (None, "") else None
        except Exception:
            lat = None
        try:
            lng = float(longitude) if longitude not in (None, "") else None
        except Exception:
            lng = None

        # If lat/lng not provided, attempt to parse from description (or free-form location text)
        if (lat is None or lng is None) and description:
            p_lat, p_lng = parse_coords_from_string(description)
            if p_lat is not None and p_lng is not None:
                lat, lng = p_lat, p_lng

        # Reject out-of-range GPS values and require a complete coordinate pair.
        if lat is not None and not -90 <= lat <= 90:
            lat = None
        if lng is not None and not -180 <= lng <= 180:
            lng = None
        if lat is None or lng is None:
            lat, lng = None, None

        # Prefer coordinates for location when available; keep original description separately.
        location_str = f"{lat},{lng}" if lat is not None and lng is not None else (description or "Unknown Road")
        road_segment_id = _road_segment_id(lat, lng)

        # Build previews list from unique_detections (if detection objects include preview_image)
        previews = []
        for ud in unique_detections:
            if ud.get('preview_image'):
                previews.append({
                    'preview_image': f"data:image/jpeg;base64,{ud['preview_image']}",
                    'frame_index': ud.get('frame_index'),
                    'severity': ud.get('severity'),
                    'occurrences': ud.get('occurrences')
                })

        # Save detection log and thumbnails into artifacts dir for verifiable evidence
        detection_log = {
            "report_id": report_id,
            "timestamp": datetime.now().isoformat(),
            "model": {
                "name": getattr(model, 'model', str(model)) if model is not None else 'unknown',
                "weights": getattr(model, 'yaml', None) or getattr(model, 'path', None) or None
            },
            "video_info": {
                "total_frames": total_frames,
                "processed_frames": processed_frames,
                "fps": fps
            },
            "per_frame_logs": per_frame_logs,
            "unique_detections": unique_detections,
        }

        try:
            log_path = os.path.join(artifacts_dir, "detection_log.json")
            with open(log_path, 'w', encoding='utf-8') as lf:
                json.dump(detection_log, lf, indent=2)
        except Exception:
            log_path = None

        # Save thumbnails (from previews) as files for quick inspection
        thumb_files = []
        try:
            for idx, ud in enumerate(unique_detections):
                b64 = ud.get('preview_image')
                if not b64:
                    continue
                # if preview_image is already data URI, strip prefix
                if b64.startswith('data:'):
                    b64data = b64.split(',', 1)[1]
                else:
                    b64data = b64
                try:
                    img_bytes = base64.b64decode(b64data)
                    thumb_name = f"thumb_{idx+1:03d}.jpg"
                    thumb_path = os.path.join(artifacts_dir, "thumbs", thumb_name)
                    with open(thumb_path, 'wb') as tf:
                        tf.write(img_bytes)
                    thumb_files.append(os.path.join("/results", "artifacts", report_id, "thumbs", thumb_name))
                except Exception:
                    continue
        except Exception:
            thumb_files = []

        # Finalize annotated video path (relative to static mount)
        annotated_rel = None
        try:
            annotated_rel = os.path.join("/results", "artifacts", report_id, "annotated.mp4")
            # annotated_tmp was created in artifacts_dir already
        except Exception:
            annotated_rel = None

        report = {
            "id": None,
            "type": "video",
            "source": "user",
            "location": location_str,
            "road_name": road_name or None,
            "description": description,
            "ai_summary": (f"Video analysis identified {len(unique_detections)} unique pothole instance(s): {severity_count['Major']} major, {severity_count['Moderate']} moderate and {severity_count['Minor']} minor."),
            "status": "Pending Submission",
            "submission_status": "draft",
            "progress": 0,
            "detections": len(unique_detections),
            "detection_details": unique_detections,
            "damage_type": "Pothole" if unique_detections else "No damage detected",
            "priority": "Major" if severity_count["Major"] else "Moderate" if severity_count["Moderate"] else "Minor" if severity_count["Minor"] else "No detected damage",
            "severity": severity_count,
            "timestamp": datetime.now().isoformat(),
            "lat": lat,
            "lng": lng,
            "road_segment_id": road_segment_id,
            "location_resolution": "GPS supplied" if lat is not None and lng is not None else "Manual location; GPS unavailable",
            "video_path": save_vpath,
            "previews": previews,
            "artifacts_url": f"/results/artifacts/{report_id}/",
            "artifacts": {
                "original": f"/results/artifacts/{report_id}/original.mp4" if art_orig else None,
                "annotated": f"/results/artifacts/{report_id}/annotated.mp4" if annotated_rel else None,
                "log": f"/results/artifacts/{report_id}/detection_log.json" if log_path else None,
                "thumbs": thumb_files,
            },
            # uploader info (if token provided)
            "uploader_id": None,
            "uploader_name": "Anonymous",
            "verified": False,
            "ai_review_required": any(d.get("confidence", 1) < 0.50 for d in unique_detections),
            "severity_method": "bounding_box_pixel_area_heuristic_not_physical_measurement",
        }

        if len(unique_detections) == 0:
            report["note"] = "No potholes detected in the submitted video."

        # Persist after resolving the authenticated uploader below.
       
        no_potholes_video = len(unique_detections) == 0
        try:
            auth_token = token
            if not auth_token and request is not None:
                auth_hdr = request.headers.get('authorization') or request.headers.get('Authorization')
                if auth_hdr and auth_hdr.lower().startswith('bearer '):
                    auth_token = auth_hdr.split(' ', 1)[1].strip()

            uploader = None
            try:
                uploader = find_user_by_token(auth_token) if auth_token else None
            except Exception:
                uploader = None

            if uploader:
                report['uploader_id'] = uploader.get('id')
                report['uploader_name'] = uploader.get('name')
                report['uploader_email'] = uploader.get('email')
                report['uploader_phone'] = uploader.get('phone')
                report['verified'] = True

            report = persist_report(report)
            dashboard_data["reports"].append(report)

        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Could not save the video complaint: {str(e)}")
        return {
            "success": True,
            "message": ("No potholes detected" if no_potholes_video else f"Video detection completed - Found {len(unique_detections)} unique potholes"),
            "no_potholes": no_potholes_video,
            "video_info": {
                "total_frames": total_frames,
                "processed_frames": processed_frames,
                "fps": fps,
                "max_detections_in_frame": max_detections_per_frame
            },
            "detections": unique_detections,
            "statistics": {
                "total_detections": len(unique_detections),
                "severity_breakdown": severity_count,
                "frames_analyzed": processed_frames
            },
            "complaint": {
                "id": report.get("id"),
                "road_segment_id": report.get("road_segment_id"),
                "duplicate_group_id": report.get("duplicate_group_id"),
                "duplicate_of": report.get("duplicate_of"),
                "status": report.get("status"),
                "timestamp": report.get("timestamp"),
            },
            "timestamp": datetime.now().isoformat()
        }
   
    except HTTPException as e:
        raise e
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error processing video: {str(e)}")

# ============== ITEMS ENDPOINT ==============

@app.get("/items/{item_id}")
def read_item(item_id: int, q: str = None):
    return {"item_id": item_id, "query": q}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=False)

# ============== ADMIN DASHBOARD ENDPOINT ==============

@app.get("/admin/stats")
def get_admin_stats():
    # Query committed complaints from the shared database; pending drafts are hidden.
    reports = [r for r in load_persisted_reports() if str(r.get("submission_status") or "submitted").lower() != "draft" and str(r.get("status") or "").lower() != "pending submission"]
    stats = {
        "total_uploads": len(reports),
        "total_detections": sum(int(r.get("detections", 0) or 0) for r in reports),
        "minor": sum(int((r.get("severity") or {}).get("Minor", 0) or 0) for r in reports),
        "moderate": sum(int((r.get("severity") or {}).get("Moderate", 0) or 0) for r in reports),
        "major": sum(int((r.get("severity") or {}).get("Major", 0) or 0) for r in reports),
        "reports": reports,
    }
    dashboard_data["reports"] = reports
    return {"success": True, "data": stats, "timestamp": datetime.now().isoformat()}


@app.get("/admin/report/{report_id}/artifacts")
def get_report_artifacts(report_id: str):
    """Return artifact file URLs for a given report id (if available)."""
    artifacts_dir = os.path.join(os.getcwd(), "results", "artifacts", report_id)
    if not os.path.exists(artifacts_dir):
        return JSONResponse(status_code=404, content={"success": False, "message": "Artifacts not found"})

    def _exists_rel(p):
        return f"/results/artifacts/{report_id}/{os.path.basename(p)}" if os.path.exists(os.path.join(artifacts_dir, os.path.basename(p))) else None

    orig = _exists_rel("original.mp4")
    ann = _exists_rel("annotated.mp4")
    log = _exists_rel("detection_log.json")

    thumbs_dir = os.path.join(artifacts_dir, "thumbs")
    thumbs = []
    if os.path.exists(thumbs_dir):
        for fn in sorted(os.listdir(thumbs_dir)):
            thumbs.append(f"/results/artifacts/{report_id}/thumbs/{fn}")

    return {"success": True, "data": {"report_id": report_id, "original": orig, "annotated": ann, "log": log, "thumbs": thumbs}}


@app.post("/admin/report/{report_id}/status")
def update_report_status(report_id: int, payload: dict = Body(...)):
    """Update a report's status/progress/notes (admin action).
    Also propagate status to any user upload entries that reference this report_id.
    """
    # Find report
    for r in dashboard_data.get("reports", []):
        if r.get("id") == int(report_id):
            # update fields
            new_status = payload.get("status")
            if new_status and new_status != r.get("status"):
                previous_status = r.get("status", "Submitted")
                r["status"] = new_status
                r.setdefault("history", []).append({
                    "status": new_status,
                    "previous_status": previous_status,
                    "message": payload.get("notes") or f"Complaint status changed to {new_status}.",
                    "timestamp": datetime.now().isoformat(),
                    "actor": "Municipal admin",
                    "visibility": "public"
                })
            if payload.get("progress") is not None:
                try:
                    r["progress"] = int(payload.get("progress", r.get("progress", 0)))
                except Exception:
                    pass
            if payload.get("notes"):
                r.setdefault("admin_notes", []).append({"timestamp": datetime.now().isoformat(), "note": payload.get("notes")})

            # Propagate status to users' upload entries that reference this report_id
            try:
                users = load_users()
                changed = False
                for u in users:
                    uploads = u.get("uploads") or []
                    for up in uploads:
                        meta = up.get("meta") or {}
                        if meta.get("report_id") == r.get("id"):
                            meta["status"] = r.get("status")
                            up["meta"] = meta
                            changed = True
                if changed:
                    save_users(users)
            except Exception:
                pass

            update_persisted_report(int(report_id), r)
            return {"success": True, "message": "Report updated", "report": r}

    return JSONResponse(status_code=404, content={"success": False, "message": "Report not found"})



# ============== ROAD LOCATION IDENTIFICATION ==============

@app.post("/roads/identify")
def identify_road(payload: dict = Body(...)):
    """Return a stable GPS-derived road segment key without inventing road ownership."""
    try:
        lat = float(payload.get("latitude", payload.get("lat")))
        lng = float(payload.get("longitude", payload.get("lng")))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Valid latitude and longitude are required.")
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        raise HTTPException(status_code=400, detail="Coordinates are outside valid GPS ranges.")
    return {
        "success": True,
        "road_segment_id": _road_segment_id(lat, lng),
        "latitude": lat,
        "longitude": lng,
        "authority": None,
        "authority_resolution": "pending_official_road_registry",
        "message": "Location identified. Official road ownership requires a verified municipal/PWD/NHAI road registry.",
    }


# ============== CITIZEN COMPLAINT TRACKING ==============

@app.get("/user/complaints")
def get_user_complaints(request: Request):
    """Return only the reports owned by the authenticated citizen."""
    auth_header = request.headers.get("authorization", "")
    token = auth_header.split(" ", 1)[1].strip() if auth_header.lower().startswith("bearer ") else ""
    user = find_user_by_token(token)
    if not user:
        raise HTTPException(status_code=401, detail="Please sign in to view your complaints.")

    # Query the persistent store directly. A process-local dashboard cache
    # can be stale when Render runs multiple workers or after a restart.
    with db_engine.connect() as connection:
        rows = connection.execute(
            select(complaints_table.c.payload)
            .where(complaints_table.c.uploader_id == str(user.get("id")))
            .order_by(complaints_table.c.id.desc())
        ).scalars().all()

    owned_reports = []
    for report in rows:
        item = dict(report)
        if str(item.get("submission_status") or "submitted").lower() == "draft" or str(item.get("status") or "").lower() == "pending submission":
            continue
        history = item.get("history") or [{
            "status": item.get("status", "In Review"),
            "message": "Your complaint was received and is awaiting review.",
            "timestamp": item.get("timestamp"),
            "actor": "System",
            "visibility": "public"
        }]
        item["history"] = [event for event in history if event.get("visibility", "public") == "public"]
        # Never expose private admin notes or filesystem paths to citizens.
        item.pop("admin_notes", None)
        item.pop("image_path", None)
        item.pop("video_path", None)
        owned_reports.append(item)

    owned_reports.sort(
        key=lambda item: item.get("timestamp") or item.get("created_at") or "",
        reverse=True,
    )
    return {"success": True, "data": owned_reports, "count": len(owned_reports)}


# ============== AUTH ENDPOINTS ==============


@app.post("/auth/signup")
def auth_signup(name: str = Form(...), email: str = Form(...), password: str = Form(...)):
    """Register a new user. Stores a salted password hash in users.json and returns a simple token."""
    users = load_users()
    email = (email or "").strip().lower()
    if any(u.get('email') == email for u in users):
        return JSONResponse(status_code=400, content={"success": False, "message": "User already exists"})

    salt, pwd_hash = hash_password(password)
    user = {
        "id": uuid.uuid4().hex,
        "name": name,
        "email": email,
        "salt": salt,
        "pwd_hash": pwd_hash,
        "created_at": datetime.now().isoformat(),
        "token": uuid.uuid4().hex,
        "coins": 0,
        "uploads": []
    }
    users.append(user)
    save_users(users)
    return {"success": True, "message": "User created", "data": {"id": user["id"], "token": user["token"], "name": user["name"], "email": user["email"], "coins": user.get("coins", 0), "uploads": user.get("uploads", [])}}


@app.post("/auth/login")
def auth_login(email: str = Form(...), password: str = Form(...)):
    """Simple login: verify password and return token."""
    users = load_users()
    email = (email or "").strip().lower()
    user = next((u for u in users if u.get('email') == email), None)
    if not user:
        return JSONResponse(status_code=401, content={"success": False, "message": "Invalid credentials"})

    if not verify_password(password, user.get('salt', ''), user.get('pwd_hash', '')):
        return JSONResponse(status_code=401, content={"success": False, "message": "Invalid credentials"})

    # refresh token for session
    token = uuid.uuid4().hex
    user['token'] = token
    save_users(users)

    return {"success": True, "message": "Authenticated", "data": {"id": user.get('id'), "token": token, "name": user.get('name'), "email": user.get('email'), "coins": user.get('coins', 0), "uploads": user.get('uploads', [])}}


@app.get('/auth/me')
def auth_me(request: Request):
    """Return the authenticated user's record based on bearer token in Authorization header or query token."""
    auth_hdr = request.headers.get('authorization') or request.query_params.get('token')
    token = None
    if auth_hdr:
        if isinstance(auth_hdr, str) and auth_hdr.lower().startswith('bearer '):
            token = auth_hdr.split(' ', 1)[1].strip()
        else:
            token = auth_hdr

    user = find_user_by_token(token)
    if not user:
        return JSONResponse(status_code=401, content={"success": False, "message": "Not authenticated"})

    # return safe user data
    safe = {"id": user.get('id'), "name": user.get('name'), "email": user.get('email'), "coins": user.get('coins', 0), "uploads": user.get('uploads', [])}
    return {"success": True, "data": safe}




@app.get("/user/complaints/{report_id}")
def get_user_complaint(report_id: int, request: Request):
    """Return a complaint/draft only to the citizen who owns it."""
    header = request.headers.get("authorization", "")
    token = header.split(" ", 1)[1].strip() if header.lower().startswith("bearer ") else ""
    user = find_user_by_token(token)
    if not user:
        raise HTTPException(status_code=401, detail="Please sign in to view this report.")
    with db_engine.connect() as connection:
        row = connection.execute(select(complaints_table.c.payload).where(complaints_table.c.id == report_id)).first()
    if not row:
        raise HTTPException(status_code=404, detail="Complaint report not found.")
    report = dict(row[0])
    if str(report.get("uploader_id") or "") != str(user.get("id")):
        raise HTTPException(status_code=403, detail="You do not have access to this complaint.")
    report.pop("image_path", None)
    report.pop("video_path", None)
    return {"success": True, "data": report}


@app.patch("/user/complaints/{report_id}/draft")
def update_user_complaint_draft(report_id: int, payload: dict = Body(...), request: Request = None):
    header = request.headers.get("authorization", "") if request else ""
    token = header.split(" ", 1)[1].strip() if header.lower().startswith("bearer ") else ""
    user = find_user_by_token(token)
    if not user:
        raise HTTPException(status_code=401, detail="Please sign in to edit this draft.")
    with db_engine.connect() as connection:
        row = connection.execute(select(complaints_table.c.payload).where(complaints_table.c.id == report_id)).first()
    if not row:
        raise HTTPException(status_code=404, detail="Complaint draft not found.")
    report = dict(row[0])
    if str(report.get("uploader_id") or "") != str(user.get("id")):
        raise HTTPException(status_code=403, detail="You do not have access to this draft.")
    if str(report.get("submission_status") or "").lower() != "draft":
        raise HTTPException(status_code=409, detail="This complaint has already been submitted.")
    changes = {}
    if "description" in payload:
        changes["description"] = str(payload.get("description") or "").strip()[:2000]
    if "location" in payload:
        changes["location"] = str(payload.get("location") or "").strip()[:500]
    if "lat" in payload or "lng" in payload:
        try:
            lat, lng = float(payload.get("lat")), float(payload.get("lng"))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Enter valid latitude and longitude coordinates.")
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            raise HTTPException(status_code=400, detail="Coordinates are outside valid ranges.")
        changes.update({"lat": lat, "lng": lng, "road_segment_id": _road_segment_id(lat, lng), "location_resolution": "Citizen corrected coordinates"})
    if changes:
        changes["updated_at"] = datetime.now().isoformat()
        report = update_persisted_report(report_id, changes)
    report.pop("image_path", None)
    return {"success": True, "data": report}


@app.post("/user/complaints/{report_id}/evidence")
async def add_user_complaint_evidence(report_id: int, file: UploadFile = File(...), request: Request = None):
    """Attach additional validated image evidence to an existing citizen complaint."""
    header = request.headers.get("authorization", "") if request else ""
    token = header.split(" ", 1)[1].strip() if header.lower().startswith("bearer ") else ""
    user = find_user_by_token(token)
    if not user:
        raise HTTPException(status_code=401, detail="Please sign in to attach evidence.")
    with db_engine.connect() as connection:
        row = connection.execute(select(complaints_table.c.payload).where(complaints_table.c.id == report_id)).first()
    if not row:
        raise HTTPException(status_code=404, detail="Complaint report not found.")
    report = dict(row[0])
    if str(report.get("uploader_id") or "") != str(user.get("id")):
        raise HTTPException(status_code=403, detail="You cannot add evidence to another user's complaint.")
    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="The evidence file is empty.")
    if len(contents) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Evidence exceeds the 10 MB limit.")
    extension = os.path.splitext(file.filename or "")[1].lower()
    if extension not in {".jpg", ".jpeg", ".png", ".webp"}:
        raise HTTPException(status_code=400, detail="Upload an image in JPG, PNG or WebP format.")
    decoded = cv2.imdecode(np.frombuffer(contents, np.uint8), cv2.IMREAD_COLOR)
    if decoded is None or decoded.shape[0] < 32 or decoded.shape[1] < 32:
        raise HTTPException(status_code=400, detail="The evidence image is invalid or too small.")
    filename = f"{uuid.uuid4().hex}{extension}"
    destination = os.path.join(RESULTS_DIR, "images", filename)
    with open(destination, "wb") as output_file:
        output_file.write(contents)
    attachment = {
        "file_name": file.filename or filename,
        "image_url": f"/results/images/{filename}",
        "uploaded_at": datetime.now().isoformat(),
        "uploaded_by": user.get("name") or "Citizen",
        "size_bytes": len(contents),
    }
    attachments = list(report.get("attachments") or [])
    attachments.append(attachment)
    updated = update_persisted_report(report_id, {"attachments": attachments})
    updated.pop("image_path", None)
    return {"success": True, "message": "Additional evidence attached.", "data": attachment}



@app.post("/user/complaints/{report_id}/submit")
def submit_user_complaint(report_id: int, request: Request):
    header = request.headers.get("authorization", "")
    token = header.split(" ", 1)[1].strip() if header.lower().startswith("bearer ") else ""
    user = find_user_by_token(token)
    if not user:
        raise HTTPException(status_code=401, detail="Please sign in before submitting an official complaint.")
    with db_engine.connect() as connection:
        row = connection.execute(select(complaints_table.c.payload).where(complaints_table.c.id == report_id)).first()
    if not row:
        raise HTTPException(status_code=404, detail="Complaint draft not found.")
    report = dict(row[0])
    if str(report.get("uploader_id") or "") != str(user.get("id")):
        raise HTTPException(status_code=403, detail="You cannot submit another user's report.")
    if str(report.get("submission_status") or "").lower() != "draft":
        return {"success": True, "message": "This complaint has already been submitted.", "data": report}
    now = datetime.now().isoformat()
    history = list(report.get("history") or [])
    history.append({"status": "Submitted", "previous_status": "Pending Submission", "message": "Official road-damage complaint submitted by the citizen.", "timestamp": now, "actor": "Citizen", "visibility": "public"})
    updated = update_persisted_report(report_id, {
        "status": "Submitted",
        "submission_status": "submitted",
        "progress": 5,
        "submitted_at": now,
        "history": history,
        "uploader_name": user.get("name") or "Not Provided",
        "uploader_email": user.get("email") or None,
        "uploader_phone": user.get("phone") or None,
    })
    if updated and int(updated.get("detections", 0) or 0) > 0:
        reward = 20 if updated.get("type") == "video" else 10
        credit_user_by_token(token, reward, {"report_id": report_id, "type": updated.get("type", "image"), "detections": updated.get("detections", 0)})
    dashboard_data["reports"] = load_persisted_reports()
    return {"success": True, "message": "Official complaint submitted successfully.", "data": updated}



# ============== ROADGUARD PRIORITY + CONTRACTOR WORKFLOW ==============
# Incidents are grouped from nearby unresolved citizen reports. Original reports
# remain intact; grouping creates one operational repair job for administrators.
contractors_table = Table(
    "smartroad_contractors",
    db_metadata,
    Column("contractor_id", String(64), primary_key=True),
    Column("payload", JSON, nullable=False),
)
db_metadata.create_all(db_engine)


def _distance_meters(lat1, lng1, lat2, lng2):
    """Haversine distance between two GPS points."""
    from math import radians, sin, cos, asin, sqrt
    earth_radius = 6371000
    dlat = radians(lat2 - lat1)
    dlng = radians(lng2 - lng1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlng / 2) ** 2
    return 2 * earth_radius * asin(sqrt(a))


def _report_severity(report):
    severity = report.get("severity") or {}
    if isinstance(severity, str):
        return severity.title()
    if isinstance(severity, dict):
        if int(severity.get("Major", 0) or 0) > 0:
            return "Major"
        if int(severity.get("Moderate", 0) or 0) > 0:
            return "Moderate"
    return "Minor"


def _priority_score(reports):
    """Explainable 0-100 decision-support score; unverified inputs are explicitly marked."""
    severity_points = {"Minor": 25, "Moderate": 55, "Major": 85}
    severity = max((severity_points.get(_report_severity(r), 25) for r in reports), default=25)

    def factor(name):
        values = []
        for report in reports:
            try:
                value = float(report.get(name))
                if 0 <= value <= 100:
                    values.append(value)
            except (TypeError, ValueError):
                continue
        return max(values) if values else 50.0, bool(values)

    safety, safety_verified = factor("safety_risk")
    traffic, traffic_verified = factor("traffic_exposure")
    road_importance, road_verified = factor("road_importance")
    report_support = min(100, len(reports) * 25)
    timestamps = [r.get("timestamp") for r in reports if r.get("timestamp")]
    oldest = min(timestamps) if timestamps else datetime.now().isoformat()
    try:
        parsed = datetime.fromisoformat(str(oldest).replace("Z", "+00:00"))
        if parsed.tzinfo:
            parsed = parsed.astimezone().replace(tzinfo=None)
        waiting_days = max(0, (datetime.now() - parsed).total_seconds() / 86400)
    except (TypeError, ValueError, OverflowError):
        waiting_days = 0
    waiting = min(100, waiting_days / 30 * 100)
    components = {
        "severity": round(severity * 0.30),
        "safety": round(safety * 0.25),
        "traffic": round(traffic * 0.15),
        "road_importance": round(road_importance * 0.15),
        "report_support": round(report_support * 0.10),
        "waiting_time": round(waiting * 0.05),
    }
    score = max(0, min(100, round(sum(components.values()))))
    band = "Critical" if score >= 75 else "High" if score >= 50 else "Moderate" if score >= 25 else "Low"
    reasons = [
        f"Damage severity contributes {components['severity']}/30 points (highest detected: {_report_severity(max(reports, key=lambda r: severity_points.get(_report_severity(r), 25)))})",
        f"Safety exposure contributes {components['safety']}/25 points ({'verified input' if safety_verified else 'neutral default: 50/100'})",
        f"Traffic exposure contributes {components['traffic']}/15 points ({'verified input' if traffic_verified else 'neutral default: 50/100'})",
        f"Road importance contributes {components['road_importance']}/15 points ({'verified input' if road_verified else 'neutral default: 50/100'})",
        f"{len(reports)} supporting citizen report(s) contribute {components['report_support']}/10 points",
        f"Waiting {round(waiting_days, 1)} day(s) contributes {components['waiting_time']}/5 points",
    ]
    quality = {
        "safety_verified": safety_verified,
        "traffic_verified": traffic_verified,
        "road_importance_verified": road_verified,
        "verified_factor_count": sum([safety_verified, traffic_verified, road_verified]),
    }
    return score, band, reasons, components, quality


def _sla_deadline(priority_band, supplied_deadline=None):
    """Return a validated explicit deadline or a priority-based default SLA deadline."""
    if supplied_deadline:
        try:
            parsed = datetime.fromisoformat(str(supplied_deadline).replace("Z", "+00:00"))
            if parsed.tzinfo:
                parsed = parsed.astimezone().replace(tzinfo=None)
            return parsed.isoformat(timespec="minutes"), "municipal_override"
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Deadline must be an ISO date or datetime.")
    hours = {"Critical": 24, "High": 72, "Moderate": 168, "Low": 336}.get(priority_band, 168)
    from datetime import timedelta
    return (datetime.now() + timedelta(hours=hours)).isoformat(timespec="minutes"), "priority_default"


def _sla_state(deadline):
    if not deadline:
        return {"sla_status": "Not set", "overdue_hours": 0, "escalation_level": 0}
    try:
        due = datetime.fromisoformat(str(deadline).replace("Z", "+00:00"))
        if due.tzinfo:
            due = due.astimezone().replace(tzinfo=None)
        overdue_hours = max(0, (datetime.now() - due).total_seconds() / 3600)
    except (TypeError, ValueError):
        return {"sla_status": "Invalid deadline", "overdue_hours": 0, "escalation_level": 0}
    if overdue_hours <= 0:
        return {"sla_status": "On track", "overdue_hours": 0, "escalation_level": 0}
    level = 1 if overdue_hours < 24 else 2 if overdue_hours < 72 else 3
    return {"sla_status": "Overdue", "overdue_hours": round(overdue_hours, 1), "escalation_level": level}


def _build_priority_incidents():
    # Always build the municipal queue from persistent complaints, not a stale worker cache.
    reports = [
        dict(r) for r in load_persisted_reports()
        if str(r.get("status", "")).lower() not in {"completed", "closed", "false image/rejected", "rejected", "pending submission"}
        and str(r.get("submission_status") or "").lower() != "draft"
        and int(r.get("detections", 0) or 0) > 0
    ]
    clusters = []
    for report in sorted(reports, key=lambda r: r.get("timestamp") or ""):
        try:
            lat, lng = float(report.get("lat")), float(report.get("lng"))
        except (TypeError, ValueError):
            lat, lng = None, None
        matched = None
        if lat is not None and lng is not None:
            for cluster in clusters:
                if cluster["lat"] is not None and _distance_meters(lat, lng, cluster["lat"], cluster["lng"]) <= 35:
                    matched = cluster
                    break
        if matched is None:
            clusters.append({"lat": lat, "lng": lng, "reports": [report]})
        else:
            matched["reports"].append(report)
            points = [(float(r["lat"]), float(r["lng"])) for r in matched["reports"] if r.get("lat") is not None and r.get("lng") is not None]
            matched["lat"] = sum(p[0] for p in points) / len(points)
            matched["lng"] = sum(p[1] for p in points) / len(points)

    incidents = []
    for cluster in clusters:
        items = cluster["reports"]
        ids = sorted([str(r.get("id")) for r in items])
        incident_id = "INC-" + hashlib.sha1(",".join(ids).encode("utf-8")).hexdigest()[:10].upper()
        score, band, reasons, score_components, data_quality = _priority_score(items)
        first = items[0]
        override_band = first.get("priority_override")
        if override_band in {"Low", "Moderate", "High", "Critical"}:
            band = override_band
            reasons.append("Municipal priority override: " + str(first.get("priority_override_reason") or "No reason recorded"))
        assignment = first.get("assignment") or {}
        sla = _sla_state(assignment.get("deadline"))
        incidents.append({
            "incident_id": incident_id,
            "report_ids": [r.get("id") for r in items],
            "supporting_reports": len(items),
            "location": first.get("location") or "Location not provided",
            "description": first.get("description") or "",
            "lat": cluster["lat"],
            "lng": cluster["lng"],
            "severity": max((_report_severity(r) for r in items), key=lambda s: {"Minor": 1, "Moderate": 2, "Major": 3}.get(s, 0)),
            "priority_score": score,
            "priority_band": band,
            "priority_reasons": reasons,
            "priority_components": score_components,
            "priority_data_quality": data_quality,
            "department": first.get("department") or "Unassigned",
            "authority": first.get("authority") or "Unassigned",
            "priority_override": override_band,
            "priority_override_reason": first.get("priority_override_reason"),
            "status": first.get("status") or "In Review",
            "contractor": first.get("contractor"),
            "assignment": assignment,
            "sla": sla,
            "contractor_work": first.get("contractor_work") or {},
            "reports": items,
        })
    incidents.sort(key=lambda item: item["priority_score"], reverse=True)
    for index, incident in enumerate(incidents, start=1):
        incident["rank"] = index
    return incidents


@app.get("/admin/priority/incidents")
def get_priority_incidents():
    """Return grouped active road incidents ranked by explainable priority score."""
    incidents = _build_priority_incidents()
    return {"success": True, "count": len(incidents), "data": incidents}


@app.get("/admin/contractors")
def get_contractors():
    with db_engine.connect() as connection:
        rows = connection.execute(select(contractors_table.c.payload)).scalars().all()
    return {"success": True, "data": [_safe_contractor(dict(row)) if "_safe_contractor" in globals() else {k: v for k, v in dict(row).items() if k not in {"salt", "pwd_hash", "token"}} for row in rows], "count": len(rows)}


@app.post("/admin/contractors")
def create_contractor(payload: dict = Body(...)):
    name = str(payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Contractor name is required")
    contractor_email = str(payload.get("email") or "").strip().lower()
    if "@" not in contractor_email or "." not in contractor_email.split("@")[-1]:
        raise HTTPException(status_code=400, detail="A valid contractor email is required for portal login")
    contractor_id = "CTR-" + uuid.uuid4().hex[:8].upper()
    password = str(payload.get("password") or "")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Portal password must contain at least 8 characters")
    salt, pwd_hash = hash_password(password)
    if any(str(row.get("email", "")).lower() == contractor_email for row in get_contractors()["data"] if row.get("email")):
        raise HTTPException(status_code=409, detail="A contractor with this email already exists")
    contractor = {
        "contractor_id": contractor_id,
        "name": name,
        "company": str(payload.get("company") or "").strip(),
        "phone": str(payload.get("phone") or "").strip(),
        "email": contractor_email,
        "service_area": str(payload.get("service_area") or "").strip(),
        "specialization": str(payload.get("specialization") or "Road repair").strip(),
        "status": "Active",
        "salt": salt,
        "pwd_hash": pwd_hash,
        "token": None,
        "created_at": datetime.now().isoformat(),
    }
    with db_engine.begin() as connection:
        connection.execute(contractors_table.insert().values(contractor_id=contractor_id, payload=contractor))
    return {"success": True, "message": "Contractor registered", "data": {k: v for k, v in contractor.items() if k not in {"salt", "pwd_hash", "token"}}}



@app.post("/admin/priority/incidents/{incident_id}/triage")
def triage_priority_incident(incident_id: str, payload: dict = Body(...)):
    """Assign a responsible municipal department and verified risk inputs to an incident."""
    incident = next((item for item in _build_priority_incidents() if item["incident_id"] == incident_id), None)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found; refresh the priority queue")
    department = str(payload.get("department") or "").strip()
    authority = str(payload.get("authority") or "").strip()
    if not department or not authority:
        raise HTTPException(status_code=400, detail="Department and responsible authority are required.")

    changes = {"department": department, "authority": authority}
    for field in ("safety_risk", "traffic_exposure", "road_importance"):
        if field in payload and payload[field] not in (None, ""):
            try:
                value = float(payload[field])
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail=f"{field} must be a number from 0 to 100.")
            if not 0 <= value <= 100:
                raise HTTPException(status_code=400, detail=f"{field} must be between 0 and 100.")
            changes[field] = value

    override = str(payload.get("priority_override") or "").strip()
    if override:
        if override not in {"Low", "Moderate", "High", "Critical"}:
            raise HTTPException(status_code=400, detail="Priority override must be Low, Moderate, High or Critical.")
        reason = str(payload.get("priority_override_reason") or "").strip()
        if len(reason) < 8:
            raise HTTPException(status_code=400, detail="A clear reason of at least 8 characters is required for a priority override.")
        changes["priority_override"] = override
        changes["priority_override_reason"] = reason
    elif payload.get("clear_priority_override"):
        changes["priority_override"] = None
        changes["priority_override_reason"] = None

    timestamp = datetime.now().isoformat()
    persisted = load_persisted_reports()
    updated = 0
    for report_id in incident["report_ids"]:
        report = next((r for r in persisted if str(r.get("id")) == str(report_id)), None)
        history = list((report or {}).get("authority_workflow") or [])
        history.append({
            "action": "municipal_triage_updated",
            "actor": "Municipal authority",
            "timestamp": timestamp,
            "details": dict(changes),
        })
        if update_persisted_report(int(report_id), {**changes, "authority_workflow": history}):
            updated += 1

    dashboard_data["reports"] = load_persisted_reports()
    return {"success": True, "message": "Municipal triage saved", "data": {"incident_id": incident_id, "updated_reports": updated, "department": department, "authority": authority}}


@app.post("/admin/priority/incidents/{incident_id}/assign")
def assign_incident_contractor(incident_id: str, payload: dict = Body(...)):
    contractor_id = str(payload.get("contractor_id") or "").strip()
    with db_engine.connect() as connection:
        contractor_row = connection.execute(
            select(contractors_table.c.payload).where(contractors_table.c.contractor_id == contractor_id)
        ).first()
    if not contractor_row:
        raise HTTPException(status_code=404, detail="Active contractor not found")
    contractor = dict(contractor_row[0])
    if contractor.get("status") != "Active":
        raise HTTPException(status_code=400, detail="This contractor is not active")

    incident = next((item for item in _build_priority_incidents() if item["incident_id"] == incident_id), None)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found; refresh the priority queue")
    deadline, sla_source = _sla_deadline(incident.get("priority_band"), payload.get("deadline"))
    work_order = str(payload.get("work_order") or "").strip()
    if not work_order:
        work_order = "WO-" + datetime.now().strftime("%Y%m%d") + "-" + uuid.uuid4().hex[:6].upper()
    assignment = {
        "contractor_id": contractor_id,
        "contractor_name": contractor.get("name"),
        "assigned_at": datetime.now().isoformat(),
        "deadline": deadline,
        "sla_source": sla_source,
        "sla_hours": {"Critical": 24, "High": 72, "Moderate": 168, "Low": 336}.get(incident.get("priority_band"), 168),
        "work_order": work_order,
        "notes": str(payload.get("notes") or "").strip(),
        "status": "Assigned",
    }
    updated = []
    persisted_reports = load_persisted_reports()
    for report_id in incident["report_ids"]:
        existing_report = next((r for r in persisted_reports if str(r.get("id")) == str(report_id)), {})
        workflow = list(existing_report.get("authority_workflow") or [])
        workflow.append({
            "action": "contractor_assigned",
            "actor": "Municipal authority",
            "timestamp": datetime.now().isoformat(),
            "details": {"contractor_id": contractor_id, "work_order": work_order, "deadline": deadline},
        })
        report = update_persisted_report(int(report_id), {
            "contractor": {"contractor_id": contractor_id, "name": contractor.get("name")},
            "assignment": assignment,
            "status": "In Progress",
            "progress": 35,
            "department": incident.get("department") or "Roads & Infrastructure",
            "authority": incident.get("authority") or "Municipal Engineering",
            "authority_workflow": workflow,
        })
        if report:
            updated.append(report)
    # Refresh in-memory dashboard after persistence updates.
    dashboard_data["reports"] = load_persisted_reports()
    return {
        "success": True,
        "message": f"Repair job assigned to {contractor.get('name')}",
        "data": {"incident_id": incident_id, "assignment": assignment, "updated_reports": len(updated)},
    }


@app.post("/admin/priority/incidents/{incident_id}/unassign")
def unassign_incident_contractor(incident_id: str):
    incident = next((item for item in _build_priority_incidents() if item["incident_id"] == incident_id), None)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    for report_id in incident["report_ids"]:
        update_persisted_report(int(report_id), {"contractor": None, "assignment": None, "status": "In Review", "progress": 25})
    dashboard_data["reports"] = load_persisted_reports()
    return {"success": True, "message": "Contractor assignment removed"}


# ============== CONTRACTOR SELF-SERVICE PORTAL ==============
def _contractor_from_request(request: Request):
    header = request.headers.get("authorization", "")
    token = header.split(" ", 1)[1].strip() if header.lower().startswith("bearer ") else ""
    if not token:
        raise HTTPException(status_code=401, detail="Contractor login required")
    with db_engine.connect() as connection:
        rows = connection.execute(select(contractors_table.c.payload)).scalars().all()
    contractor = next((dict(row) for row in rows if row.get("token") == token and row.get("status") == "Active"), None)
    if not contractor:
        raise HTTPException(status_code=401, detail="Contractor session expired. Please sign in again.")
    return contractor


def _safe_contractor(contractor):
    return {key: value for key, value in contractor.items() if key not in {"salt", "pwd_hash", "token"}}


def _save_contractor(contractor):
    with db_engine.begin() as connection:
        connection.execute(
            contractors_table.update()
            .where(contractors_table.c.contractor_id == contractor["contractor_id"])
            .values(payload=contractor)
        )


@app.post("/contractor/auth/login")
def contractor_login(email: str = Form(...), password: str = Form(...)):
    email = (email or "").strip().lower()
    with db_engine.connect() as connection:
        rows = connection.execute(select(contractors_table.c.payload)).scalars().all()
    contractor = next((dict(row) for row in rows if str(row.get("email", "")).lower() == email), None)
    if not contractor or not contractor.get("pwd_hash") or not verify_password(password, contractor.get("salt", ""), contractor.get("pwd_hash", "")):
        raise HTTPException(status_code=401, detail="Invalid contractor email or password")
    if contractor.get("status") != "Active":
        raise HTTPException(status_code=403, detail="This contractor account is inactive")
    contractor["token"] = uuid.uuid4().hex
    _save_contractor(contractor)
    return {"success": True, "message": "Signed in", "data": {"token": contractor["token"], "contractor": _safe_contractor(contractor)}}


@app.get("/contractor/auth/me")
def contractor_me(request: Request):
    contractor = _contractor_from_request(request)
    return {"success": True, "data": _safe_contractor(contractor)}


@app.get("/contractor/jobs")
def contractor_jobs(request: Request):
    contractor = _contractor_from_request(request)
    jobs = []
    for incident in _build_priority_incidents():
        assignment = incident.get("assignment") or {}
        if assignment.get("contractor_id") != contractor.get("contractor_id"):
            continue
        work = (incident.get("reports") or [{}])[0].get("contractor_work") or {}
        incident["contractor_work"] = work
        incident.pop("reports", None)
        jobs.append(incident)
    jobs.sort(key=lambda job: (job.get("assignment") or {}).get("deadline") or "9999-12-31")
    return {"success": True, "count": len(jobs), "data": jobs}


@app.post("/contractor/jobs/{incident_id}/evidence")
async def contractor_upload_evidence(incident_id: str, request: Request, evidence_type: str = Form(...), file: UploadFile = File(...)):
    contractor = _contractor_from_request(request)
    if evidence_type not in {"before", "after"}:
        raise HTTPException(status_code=400, detail="Evidence type must be before or after")
    incident = next((item for item in _build_priority_incidents() if item["incident_id"] == incident_id), None)
    if not incident or (incident.get("assignment") or {}).get("contractor_id") != contractor["contractor_id"]:
        raise HTTPException(status_code=404, detail="Assigned repair job not found")
    content = await file.read()
    if not content or len(content) > 12 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Upload an image smaller than 12 MB")
    content_type = (file.content_type or "").lower()
    if not content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image evidence is accepted")
    extension = os.path.splitext(file.filename or "")[1].lower()
    if extension not in {".jpg", ".jpeg", ".png", ".webp"}:
        extension = ".jpg" if "jpeg" in content_type else ".png" if "png" in content_type else ".webp"
    evidence_dir = os.path.join(RESULTS_DIR, "contractor_evidence")
    os.makedirs(evidence_dir, exist_ok=True)
    filename = f"{incident_id}_{evidence_type}_{uuid.uuid4().hex}{extension}"
    with open(os.path.join(evidence_dir, filename), "wb") as output:
        output.write(content)
    evidence = {
        "type": evidence_type,
        "url": f"/results/contractor_evidence/{filename}",
        "filename": filename,
        "uploaded_at": datetime.now().isoformat(),
        "uploaded_by": contractor["contractor_id"],
    }
    for report_id in incident["report_ids"]:
        report = update_persisted_report(int(report_id), {})
        if report:
            work = dict(report.get("contractor_work") or {})
            evidence_items = list(work.get("evidence") or [])
            evidence_items.append(evidence)
            work["evidence"] = evidence_items
            work["updated_at"] = datetime.now().isoformat()
            update_persisted_report(int(report_id), {"contractor_work": work})
    dashboard_data["reports"] = load_persisted_reports()
    return {"success": True, "message": f"{evidence_type.title()} repair evidence uploaded", "data": evidence}


@app.post("/contractor/jobs/{incident_id}/status")
def contractor_update_job_status(incident_id: str, request: Request, payload: dict = Body(...)):
    contractor = _contractor_from_request(request)
    action = str(payload.get("action") or "").lower()
    allowed = {"accept", "start", "submit_for_verification"}
    if action not in allowed:
        raise HTTPException(status_code=400, detail="Unsupported job action")
    incident = next((item for item in _build_priority_incidents() if item["incident_id"] == incident_id), None)
    if not incident or (incident.get("assignment") or {}).get("contractor_id") != contractor["contractor_id"]:
        raise HTTPException(status_code=404, detail="Assigned repair job not found")
    reports = incident.get("reports") or []
    existing_work = dict(reports[0].get("contractor_work") or {}) if reports else {}
    evidence = existing_work.get("evidence") or []
    if action == "submit_for_verification" and not any(item.get("type") == "after" for item in evidence):
        raise HTTPException(status_code=400, detail="Upload an after-repair photo before submitting this job")
    if action == "accept":
        status, progress, label = "Accepted", 40, "Accepted"
    elif action == "start":
        status, progress, label = "In Progress", 65, "Work Started"
    else:
        status, progress, label = "Site Verification", 90, "Submitted for Verification"
    work = {**existing_work, "status": label, "updated_at": datetime.now().isoformat(), "contractor_note": str(payload.get("note") or "").strip()}
    for report_id in incident["report_ids"]:
        update_persisted_report(int(report_id), {"status": status, "progress": progress, "contractor_work": work})
    dashboard_data["reports"] = load_persisted_reports()
    return {"success": True, "message": f"Job {label.lower()}", "data": {"incident_id": incident_id, "status": status, "progress": progress}}


@app.post("/admin/priority/incidents/{incident_id}/verify")
def admin_verify_repair(incident_id: str, payload: dict = Body(...)):
    incident = next((item for item in _build_priority_incidents() if item["incident_id"] == incident_id), None)
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found")
    approved = bool(payload.get("approved"))
    note = str(payload.get("note") or "").strip()
    status = "Completed" if approved else "In Progress"
    progress = 100 if approved else 65
    work = dict((incident.get("reports") or [{}])[0].get("contractor_work") or {})
    work.update({"status": "Verified" if approved else "Rework Requested", "verification_note": note, "verified_at": datetime.now().isoformat()})
    for report_id in incident["report_ids"]:
        update_persisted_report(int(report_id), {"status": status, "progress": progress, "contractor_work": work})
    dashboard_data["reports"] = load_persisted_reports()
    return {"success": True, "message": "Repair verified" if approved else "Rework requested", "data": {"incident_id": incident_id, "status": status, "contractor_work": work}}


@app.post("/admin/contractors/{contractor_id}/credentials")
def set_contractor_credentials(contractor_id: str, payload: dict = Body(...)):
    password = str(payload.get("password") or "")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Portal password must contain at least 8 characters")
    with db_engine.connect() as connection:
        row = connection.execute(select(contractors_table.c.payload).where(contractors_table.c.contractor_id == contractor_id)).first()
    if not row:
        raise HTTPException(status_code=404, detail="Contractor not found")
    contractor = dict(row[0])
    if not contractor.get("email"):
        raise HTTPException(status_code=400, detail="Add an email address to this contractor first")
    salt, pwd_hash = hash_password(password)
    contractor.update({"salt": salt, "pwd_hash": pwd_hash, "token": None})
    _save_contractor(contractor)
    return {"success": True, "message": "Contractor portal credentials saved"}
