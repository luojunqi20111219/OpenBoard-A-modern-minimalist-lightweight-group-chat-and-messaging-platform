#define WEBVIEW_MSWEBVIEW2_EXPLICIT_LINK 1
#include "webview.h"

#ifdef _WIN32
#include <windows.h>
#include <shellapi.h>
#include <vector>
#include <string>

#define WM_TRAYICON (WM_APP + 1)
NOTIFYICONDATAW g_nid = {0};
WNDPROC oldWndProc = nullptr;
HWND g_hwnd = nullptr;
webview::webview* g_webview = nullptr;
std::string g_lastNotificationRoomId = "";
std::string g_lastNotificationSenderUsername = "";
std::string g_lastNotificationSenderNickname = "";
std::string g_lastNotificationSenderAvatar = "";

HICON g_hIconNormal = nullptr;
HICON g_hIconEmpty = nullptr;
bool g_is_flashing = false;
bool g_flash_toggle = false;

std::wstring Utf8ToUtf16(const std::string& str) {
    if (str.empty()) return L"";
    int size_needed = MultiByteToWideChar(CP_UTF8, 0, &str[0], (int)str.size(), NULL, 0);
    std::wstring wstrTo(size_needed, 0);
    MultiByteToWideChar(CP_UTF8, 0, &str[0], (int)str.size(), &wstrTo[0], size_needed);
    return wstrTo;
}

std::vector<std::string> ParseJsonArray(const std::string& json) {
    std::vector<std::string> res;
    size_t i = 0;
    while (i < json.length()) {
        if (json[i] == '"') {
            std::string s;
            i++;
            while (i < json.length()) {
                if (json[i] == '\\' && i + 1 < json.length()) {
                    s += json[i+1];
                    i += 2;
                } else if (json[i] == '"') {
                    res.push_back(s);
                    i++;
                    break;
                } else {
                    s += json[i];
                    i++;
                }
            }
        } else {
            i++;
        }
    }
    return res;
}

HICON CreateEmptyIcon() {
    int cx = GetSystemMetrics(SM_CXSMICON);
    int cy = GetSystemMetrics(SM_CYSMICON);
    HBITMAP hbmMono = CreateBitmap(cx, cy, 1, 1, NULL);
    ICONINFO ii = {0};
    ii.fIcon = TRUE;
    ii.hbmMask = hbmMono;
    ii.hbmColor = hbmMono;
    HICON hIcon = CreateIconIndirect(&ii);
    DeleteObject(hbmMono);
    return hIcon;
}

void SetupTrayIcon(HWND hwnd) {
    g_nid.cbSize = sizeof(NOTIFYICONDATAW);
    g_nid.hWnd = hwnd;
    g_nid.uID = 1;
    g_nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
    g_nid.uCallbackMessage = WM_TRAYICON;
    
    // Load embedded resource icon (ID 101) with fallback to default application icon
    g_hIconNormal = LoadIconW(GetModuleHandleW(NULL), MAKEINTRESOURCEW(101));
    if (!g_hIconNormal) {
        g_hIconNormal = LoadIconW(NULL, (LPCWSTR)IDI_APPLICATION);
    }
    g_hIconEmpty = CreateEmptyIcon();
    g_nid.hIcon = g_hIconNormal;
    
    // Set window icon for taskbar and titlebar
    SendMessageW(hwnd, WM_SETICON, ICON_BIG, (LPARAM)g_hIconNormal);
    SendMessageW(hwnd, WM_SETICON, ICON_SMALL, (LPARAM)g_hIconNormal);
    
    wcscpy_s(g_nid.szTip, L"信语 (OpenBoard)");
    g_nid.uVersion = NOTIFYICON_VERSION;
    
    BOOL addRet = Shell_NotifyIconW(NIM_ADD, &g_nid);
    BOOL verRet = Shell_NotifyIconW(NIM_SETVERSION, &g_nid);
    
    FILE* debugF = fopen("C:\\Users\\32709\\Desktop\\debug_tray.txt", "a");
    if (debugF) {
        fprintf(debugF, "SetupTrayIcon: NIM_ADD=%d, NIM_SETVERSION=%d (uVersion=%d)\n", 
                addRet, verRet, (int)g_nid.uVersion);
        fclose(debugF);
    }
}

void ShowNotification(HWND hwnd, const wchar_t* title, const wchar_t* message) {
    NOTIFYICONDATAW nid = {0};
    nid.cbSize = sizeof(NOTIFYICONDATAW);
    nid.hWnd = hwnd;
    nid.uID = 1;
    nid.uFlags = NIF_INFO;
    nid.dwInfoFlags = NIIF_INFO;
    wcscpy_s(nid.szInfoTitle, title);
    wcscpy_s(nid.szInfo, message);
    Shell_NotifyIconW(NIM_MODIFY, &nid);
}

void StopFlashing(HWND hwnd) {
    if (!g_is_flashing) return;
    g_is_flashing = false;
    KillTimer(hwnd, 1);
    
    // Restore normal tray icon
    g_nid.hIcon = g_hIconNormal;
    Shell_NotifyIconW(NIM_MODIFY, &g_nid);
    
    // Stop taskbar flashing
    FLASHWINFO fwi = {0};
    fwi.cbSize = sizeof(FLASHWINFO);
    fwi.hwnd = hwnd;
    fwi.dwFlags = FLASHW_STOP;
    FlashWindowEx(&fwi);
}

void StartFlashing(HWND hwnd) {
    // Only flash if the window is currently not the foreground active window
    if (GetForegroundWindow() == hwnd) return;
    if (g_is_flashing) return;
    
    g_is_flashing = true;
    g_flash_toggle = false;
    SetTimer(hwnd, 1, 500, NULL); // Flash every 500ms
    
    // Flash taskbar icon until the window comes to foreground
    FLASHWINFO fwi = {0};
    fwi.cbSize = sizeof(FLASHWINFO);
    fwi.hwnd = hwnd;
    fwi.dwFlags = FLASHW_ALL | FLASHW_TIMERNOFG;
    fwi.uCount = 0; // Keep flashing
    fwi.dwTimeout = 0;
    FlashWindowEx(&fwi);
}

LRESULT CALLBACK MyWndProc(HWND hwnd, UINT uMsg, WPARAM wParam, LPARAM lParam) {
    switch (uMsg) {
        case WM_CLOSE:
            // Intercept close button and hide window to keep running in background
            ShowWindow(hwnd, SW_HIDE);
            return 0;
        case WM_SIZE:
            if (wParam == SIZE_MINIMIZED) {
                // Intercept minimize button and hide window to tray
                ShowWindow(hwnd, SW_HIDE);
                return 0;
            }
            break;
        case WM_ACTIVATE:
            // Stop flashing when window becomes active
            if (LOWORD(wParam) != WA_INACTIVE) {
                StopFlashing(hwnd);
            }
            break;
        case WM_TIMER:
            if (wParam == 1) {
                g_flash_toggle = !g_flash_toggle;
                g_nid.hIcon = g_flash_toggle ? g_hIconEmpty : g_hIconNormal;
                Shell_NotifyIconW(NIM_MODIFY, &g_nid);
            }
            break;
        case WM_TRAYICON: {
            unsigned int eventId = (unsigned int)lParam;
            FILE* debugF = fopen("C:\\Users\\32709\\Desktop\\debug_tray.txt", "a");
            if (debugF) {
                fprintf(debugF, "WM_TRAYICON event received: 0x%X (NIN_BALLOONUSERCLICK is 0x%X, WM_LBUTTONUP is 0x%X)\n", 
                        eventId, (unsigned int)NIN_BALLOONUSERCLICK, (unsigned int)WM_LBUTTONUP);
                fclose(debugF);
            }
            if (lParam == WM_LBUTTONUP || lParam == WM_LBUTTONDBLCLK || lParam == NIN_BALLOONUSERCLICK) {
                ShowWindow(hwnd, SW_SHOW);
                ShowWindow(hwnd, SW_RESTORE);
                SetActiveWindow(hwnd);
                SetForegroundWindow(hwnd);
                
                if (lParam == NIN_BALLOONUSERCLICK && g_webview) {
                    FILE* debugF = fopen("C:\\Users\\32709\\Desktop\\debug_tray.txt", "a");
                    if (debugF) {
                        fprintf(debugF, "NIN_BALLOONUSERCLICK clicked. RoomId='%s', SenderUsername='%s', SenderNickname='%s', SenderAvatar='%s'\n",
                                g_lastNotificationRoomId.c_str(), g_lastNotificationSenderUsername.c_str(), g_lastNotificationSenderNickname.c_str(), g_lastNotificationSenderAvatar.c_str());
                        fclose(debugF);
                    }
                    std::string js = "if(window.openChatFromNotification) { window.openChatFromNotification('" 
                        + g_lastNotificationRoomId + "', '" 
                        + g_lastNotificationSenderUsername + "', '" 
                        + g_lastNotificationSenderNickname + "', '" 
                        + g_lastNotificationSenderAvatar + "'); }";
                    g_webview->eval(js);
                }
            } else if (lParam == WM_RBUTTONUP) {
                // Show tray context menu
                POINT pt;
                GetCursorPos(&pt);
                HMENU hMenu = CreatePopupMenu();
                AppendMenuW(hMenu, MF_STRING, 1, L"显示主界面");
                AppendMenuW(hMenu, MF_STRING, 2, L"退出信语");
                SetForegroundWindow(hwnd);
                int tracking = TrackPopupMenu(hMenu, TPM_RETURNCMD | TPM_NONOTIFY, pt.x, pt.y, 0, hwnd, NULL);
                if (tracking == 1) {
                    ShowWindow(hwnd, SW_SHOW);
                    ShowWindow(hwnd, SW_RESTORE);
                    SetActiveWindow(hwnd);
                    SetForegroundWindow(hwnd);
                } else if (tracking == 2) {
                    // Clean up and exit
                    Shell_NotifyIconW(NIM_DELETE, &g_nid);
                    DestroyWindow(hwnd);
                }
                DestroyMenu(hMenu);
            }
        }
            break;
        case WM_DESTROY:
            Shell_NotifyIconW(NIM_DELETE, &g_nid);
            if (g_hIconEmpty) DestroyIcon(g_hIconEmpty);
            PostQuitMessage(0);
            break;
    }
    return CallWindowProcW(oldWndProc, hwnd, uMsg, wParam, lParam);
}
#endif

#ifdef _WIN32
int WINAPI WinMain(HINSTANCE hInst, HINSTANCE hPrevInst, LPSTR lpCmdLine, int nCmdShow) {
    HANDLE hMutex = CreateMutexW(NULL, TRUE, L"Global\\OpenBoardSingleInstanceMutex");
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        HWND hwndExisting = FindWindowW(NULL, L"信语");
        if (hwndExisting) {
            ShowWindow(hwndExisting, SW_SHOW);
            ShowWindow(hwndExisting, SW_RESTORE);
            SetActiveWindow(hwndExisting);
            SetForegroundWindow(hwndExisting);
        }
        CloseHandle(hMutex);
        return 0;
    }
    
    // Disable background timer throttling and suspension for WebView2
    SetEnvironmentVariableW(L"WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", L"--disable-background-timer-throttling --disable-renderer-backgrounding");
#else
int main() {
#endif
    webview::webview w(true, nullptr);
    w.set_title("信语");
    w.set_size(1080, 800, WEBVIEW_HINT_NONE);
    
#ifdef _WIN32
    g_webview = &w;
    g_hwnd = (HWND)w.window().value();
    SetupTrayIcon(g_hwnd);
    oldWndProc = (WNDPROC)SetWindowLongPtrW(g_hwnd, GWLP_WNDPROC, (LONG_PTR)MyWndProc);
#endif

    // Bind JavaScript notify function to C++
    w.bind("desktopNotify", [](std::string seq, std::string req, void* arg) -> std::string {
        std::vector<std::string> params = ParseJsonArray(req);
        if (params.size() >= 2) {
            std::wstring title = Utf8ToUtf16(params[0]);
            std::wstring msg = Utf8ToUtf16(params[1]);
#ifdef _WIN32
            if (params.size() >= 3) g_lastNotificationRoomId = params[2];
            else g_lastNotificationRoomId = "";

            if (params.size() >= 4) g_lastNotificationSenderUsername = params[3];
            else g_lastNotificationSenderUsername = "";

            if (params.size() >= 5) g_lastNotificationSenderNickname = params[4];
            else g_lastNotificationSenderNickname = "";

            if (params.size() >= 6) g_lastNotificationSenderAvatar = params[5];
            else g_lastNotificationSenderAvatar = "";

            ShowNotification(g_hwnd, title.c_str(), msg.c_str());
            StartFlashing(g_hwnd);
#endif
        }
        return "";
    }, nullptr);

    // Inject message interceptor script
    w.init(R"(
        (function() {
            function hookMessage() {
                if (window.handleNewMessage) {
                    var oldHandleNewMessage = window.handleNewMessage;
                    window.handleNewMessage = function(data) {
                        if (oldHandleNewMessage) {
                            oldHandleNewMessage(data);
                        }
                        try {
                            if (currentUser && data.name !== currentUser.username) {
                                if (window.desktopNotify) {
                                    // Use data.content for message content, and nickname/name for sender
                                    var sender = data.nickname || data.name || "新消息";
                                    var text = data.content || "";
                                    // Strip html-like tags if any
                                    text = text.replace(/\[img:[^\]]+\]/g, "[图片]")
                                               .replace(/\[file:[^\|]+\|([^\]]+)\]/g, "[文件: $1]")
                                               .replace(/\[file:[^\]]+\]/g, "[文件]");
                                    window.desktopNotify(
                                        sender, 
                                        text, 
                                        String(data.receiver ? "-1" : (data.room_id !== undefined && data.room_id !== null ? data.room_id : "-1")),  
                                        data.name || "", 
                                        data.nickname || "", 
                                        data.avatar || ""
                                    );
                                }
                            }
                        } catch(e) {
                            console.error("Desktop notify error:", e);
                        }
                    };
                    console.log("handleNewMessage hooked successfully!");
                } else {
                    setTimeout(hookMessage, 100);
                }
            }
            hookMessage();
        })();
    )");

    w.navigate("http://liuyan.luojunqi.xyz");
    w.run();
#ifdef _WIN32
    if (hMutex) CloseHandle(hMutex);
#endif
    return 0;
}
