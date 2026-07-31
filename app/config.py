import os
import secrets
from pathlib import Path

def _load_jwt_secret():
    configured_secret = os.getenv("JWT_SECRET")
    if configured_secret:
        return configured_secret

    secret_path = Path(os.getenv("JWT_SECRET_FILE", ".openboard_jwt_secret"))
    if secret_path.exists():
        return secret_path.read_text(encoding="utf-8").strip()

    generated_secret = secrets.token_urlsafe(48)
    secret_path.write_text(generated_secret, encoding="utf-8")
    try:
        secret_path.chmod(0o600)
    except OSError:
        pass
    return generated_secret

class Config:
    DB_FILE = "board.db"
    UPLOAD_DIR = "uploads"
    JWT_SECRET = _load_jwt_secret()
    JWT_ALGORITHM = "HS256"
    JWT_EXP_MINUTES = 60 * 24 * 7  # 7 days
    CURRENT_VERSION = "v8.0.0"
    REPO_URL = "luojunqi20111219/OpenBoard-A-modern-minimalist-lightweight-group-chat-and-messaging-platform"
    ALLOWED_ADMINS = ["官方账号", "Forest_siri", "Forest_Brian_Birch"]  # Legacy fallback for backwards compatibility


# Ensure upload directory exists
os.makedirs(Config.UPLOAD_DIR, exist_ok=True)
