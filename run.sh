#!/bin/bash

# --- Color Definitions ---
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

clear
echo -e "${BLUE}===================================================${NC}"
echo -e "${BLUE}  💬 OpenBoard - Lightweight Group Chat Server     ${NC}"
echo -e "${BLUE}===================================================${NC}"
echo

# 1. Check Python Environment
echo -e "[*] Checking Python environment..."
if command -v python3 &>/dev/null; then
    PYTHON_CMD="python3"
elif command -v python &>/dev/null; then
    PYTHON_CMD="python"
else
    echo -e "${RED}[ERROR] Python was not found! Please install Python 3.8+ first.${NC}"
    exit 1
fi
$PYTHON_CMD --version

# 2. Start service instantly
echo -e "${GREEN}[SUCCESS] Python environment verified.${NC}"

echo
echo -e "${BLUE}===================================================${NC}"
echo -e "${GREEN}  🚀 Server is ready!${NC}"
echo -e "  🌍 Local address: ${BLUE}http://127.0.0.1:5000${NC}"
echo -e "  🛡️ Admin dashboard: ${BLUE}http://127.0.0.1:5000/admin${NC}"
echo -e "  🔑 Default Admin: 官方账号  Password: 12345678"
echo
echo -e "  [*] Starting FastAPI ASGI service..."
echo -e "${BLUE}===================================================${NC}"
echo

# 3. Run application
exec $PYTHON_CMD -m app.main
