# XinYu 信语 - Open Source Chat App

<div align="center">

![Platform](https://img.shields.io/badge/Platform-Android-green)
![Language](https://img.shields.io/badge/Language-Kotlin-blue)
![License](https://img.shields.io/badge/License-MIT-lightgrey)
![Min SDK](https://img.shields.io/badge/Min%20SDK-24-orange)

**A simple, open-source Android chat application built with Kotlin, Retrofit, and WebSocket.**

[Features](#features) • [Screenshots](#screenshots) • [Getting Started](#getting-started) • [API](#api-reference) • [Architecture](#architecture) • [License](#license)

</div>

---

## Features

- **Multi-user chat rooms** — Join group chat rooms with multiple participants
- **Private messaging** — 1-on-1 private chat with any user
- **Real-time messaging** — WebSocket-based instant message delivery
- **Group management** — Create and join chat groups
- **File & image sharing** — Upload and share files/images
- **Message recall** — Delete your own messages
- **User profiles** — Customizable nicknames and avatars
- **Beautiful UI** — Material Design with smooth animations

---

## Screenshots

| Login | Chat List | Private Chat | Groups |
|:---:|:---:|:---:|:---:|
| ![Login](docs/screenshots/login.png) | ![Chat List](docs/screenshots/chat_list.png) | ![Chat](docs/screenshots/chat.png) | ![Groups](docs/screenshots/groups.png) |

---

## Getting Started

### Prerequisites

- **Android Studio** Hedgehog (2024.1.1) or newer
- **JDK** 17+
- **Android SDK** API 34 (compileSdk)
- **Gradle** 8.5+ (wrapper included)

### Clone & Build

```bash
git clone https://github.com/yourusername/xinyu-chat.git
cd xinyu-chat
./gradlew assembleDebug
```

Or import directly into Android Studio:
1. File → Open → select the project directory
2. Wait for Gradle sync to complete
3. Run on device/emulator: ▶ Run → Run 'app'

### Backend Server

By default, the app connects to `http://liuyan.luojunqi.xyz:5000`. To use your own server:

1. Deploy the backend from [openboard-server](https://github.com/yourusername/openboard-server)
2. Update `BASE_URL` in `RetrofitClient.kt`:
   ```kotlin
   private const val BASE_URL = "https://your-server.com/"
   ```

---

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/login` | POST | User login |
| `/api/register` | POST | User registration |
| `/api/messages` | GET | Get messages (query: `room_id`, `target_user`) |
| `/api/messages` | POST | Send a message |
| `/api/messages/{id}` | DELETE | Recall/delete a message |
| `/api/upload` | POST | Upload file (multipart) |
| `/api/users` | GET | Get all users |
| `/api/groups` | GET | Get all groups |
| `/api/groups` | POST | Create a group |
| `/api/groups/{id}` | DELETE | Delete a group |
| `/api/ws` | WS | WebSocket for real-time messaging |

### WebSocket Message Format

```json
{
  "type": "message",
  "user": "username",
  "content": "Hello!",
  "room_id": 1,
  "receiver": "",
  "time": "2024-01-01 12:00:00"
}
```

---

## Architecture

```
app/
├── data/
│   ├── api/          # Retrofit API & WebSocket
│   ├── local/        # SharedPreferences session
│   ├── model/        # Data models (User, Message, Group, etc.)
│   └── repository/   # Repository pattern
└── ui/
    ├── adapter/      # RecyclerView adapters
    ├── chat/         # Chat activity
    ├── login/        # Login/Register
    └── main/         # Main screen fragments
```

**Architecture Pattern:** MVVM + Repository + Clean Architecture

**Tech Stack:**
- Kotlin Coroutines for async
- Retrofit 2 + OkHttp for networking
- Coil for image loading
- Material Design Components
- AndroidX ViewBinding

---

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork it
2. Create your feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -am 'Add some feature'`
4. Push to the branch: `git push origin feature/my-feature`
5. Open a Pull Request

---

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

## Acknowledgments

- Built with [Retrofit](https://github.com/square/retrofit)
- Icons by [Material Design](https://material.io/icons)
- Image loading by [Coil](https://github.com/coil-kt/coil)
