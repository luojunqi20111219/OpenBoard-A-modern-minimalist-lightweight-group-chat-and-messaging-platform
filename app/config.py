import os

class Config:
    DB_FILE = "board.db"
    UPLOAD_DIR = "uploads"
    JWT_SECRET = os.getenv("JWT_SECRET", "openboard-super-secure-jwt-secret-key-2026")
    JWT_ALGORITHM = "HS256"
    JWT_EXP_MINUTES = 60 * 24 * 7  # 7 days
    CURRENT_VERSION = "v3.0"
    REPO_URL = "luojunqi20111219/OpenBoard-A-modern-minimalist-lightweight-group-chat-and-messaging-platform"
    ALLOWED_ADMINS = ["官方账号"]  # Legacy fallback for backwards compatibility

# Ensure upload directory exists
os.makedirs(Config.UPLOAD_DIR, exist_ok=True)
