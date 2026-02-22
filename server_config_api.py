# server_config_api.py
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from pathlib import Path
import json
import os
import tempfile
from datetime import datetime

from jsonschema import Draft202012Validator

APP = FastAPI()

APP.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten later
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

CONFIG_PATH = Path("./config/scanner_config.json")
SCHEMA_PATH = Path("./config/scanner.schema.json")
BACKUP_DIR = Path("./config/backups")

BACKUP_DIR.mkdir(parents=True, exist_ok=True)

print(f" CONFIG      {CONFIG_PATH}")
print(f" SCHEMA Path {SCHEMA_PATH}")
print(f" BACKUP_DIR  {BACKUP_DIR}")

def _load_json(path: Path):
    if not path.exists():
        raise FileNotFoundError(str(path))
    return json.loads(path.read_text(encoding="utf-8"))


def _atomic_write_json(path: Path, data: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    # atomic write (write temp + replace)
    fd, tmp_path = tempfile.mkstemp(dir=str(path.parent), prefix=path.name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp_path, path)
    finally:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass


def _validator():
    schema = _load_json(SCHEMA_PATH)
    return Draft202012Validator(schema)

def _write_backup_json(config_path: Path, data: dict):
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = BACKUP_DIR / f"{config_path.stem}.{ts}.json"
    _atomic_write_json(backup_path, data)
    return backup_path.name

class ConfigPayload(BaseModel):
    config: dict


@APP.get("/api/config/schema")
def get_schema():
    try:
        return _load_json(SCHEMA_PATH)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Schema file not found")


@APP.get("/api/config")
def get_config():
    try:
        return _load_json(CONFIG_PATH)
    except FileNotFoundError:
        # Optional: create a minimal default if missing
        raise HTTPException(status_code=404, detail="Config file not found")


@APP.put("/api/config")
def save_config(payload: ConfigPayload):
    v = _validator()
    errors = sorted(v.iter_errors(payload.config), key=lambda e: e.path)

    if errors:
        return {
            "ok": False,
            "errors": [
                {
                    "path": "/".join([str(x) for x in err.path]),
                    "message": err.message,
                }
                for err in errors[:50]
            ],
        }
    # backup current config (if it exists)
    backup_name = None
    if CONFIG_PATH.exists():
        current = _load_json(CONFIG_PATH)
        backup_name = _write_backup_json(CONFIG_PATH, current)

    _atomic_write_json(CONFIG_PATH, payload.config)
    return {"ok": True, "backup": backup_name}
