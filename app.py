# ==========================================
# 💬 信语 (OpenBoard) - 现代化模块化入口重定向
# ==========================================
# 本文件已重构为模块化包结构，相关核心代码已移至 app/ 目录。
# 保留本文件作为兼容性入口，直接拉起 app.main:app。

import uvicorn

if __name__ == "__main__":
    uvicorn.run("app.main:app", host="0.0.0.0", port=5000, reload=True)