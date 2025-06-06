# 🔌 YPTSocket – Secure WebSocket Server for AVideo

**YPTSocket** is a secure, real-time WebSocket server built with **Node.js**, designed to integrate with the **AVideo** platform through a PHP bridge. It allows clients to connect using tokens, enabling real-time features like live chat, user tracking, broadcast messaging, and more.

> 📁 Project directory: `plugin/YPTSocket/AVideo-Socket/`

---

## 🚀 Features

- 🔐 Secure WebSocket (WSS) using HTTPS and SSL
- 🧠 PHP-based token authentication and user info decryption
- 👥 Tracks connected users with metadata (user ID, live key, video ID, etc.)
- 📡 Intelligent message routing (to a user, device, live key, or all clients)
- 📨 Periodic message batching and broadcasting
- 🔌 Deep integration with the AVideo platform

---

## ⚙️ How It Works

1. Clients connect to the WebSocket server using a `webSocketToken`.
2. The server delegates token decryption and user info retrieval to a PHP process (`worker.php`).
3. Upon validation, the client is accepted and registered in memory.
4. Messages sent by users are routed:
   - To themselves
   - To other users or devices
   - To all clients watching a specific live key
   - Or broadcasted to all

---

## 📦 Setup & Deployment

### 1. Clone & Install Dependencies

```bash
cd plugin/YPTSocket/AVideo-Socket/
npm install
```

---

### 2. Ensure PHP Worker Exists

Make sure you have a `worker.php` file in the same directory. It should read JSON from STDIN and return JSON via STDOUT.

Example PHP request (from Node):
```json
{ "id": "123", "action": "getDecryptedInfo", "token": "ABCDEF" }
```

---

### 3. Plugin Configuration in MySQL

Ensure the `YPTSocket` plugin entry exists in your AVideo MySQL database, with values like:

| Field              | Description                              |
|-------------------|------------------------------------------|
| `server_key_file` | Path to your SSL private key (e.g. `.key`) |
| `server_crt_file` | Path to your SSL certificate (e.g. `.crt`) |
| `host`            | IP or hostname to bind (e.g. `0.0.0.0`)     |
| `port`            | Port to use (default: `2053`)              |
| `uri`             | Optional bind address                      |

---

### 4. SSL Certificates

Ensure the `.key` and `.crt` paths defined in the database are valid and readable by Node.js.

---

### 5. Start the WebSocket Server

```bash
node server.js
```

You should see:

```
YPTSocket
🚀 Secure WebSocket Server is Running!
📡 Listening on: wss://your-domain:2053
```

---

## 🧪 WebSocket Test

Example browser-side JavaScript:

```js
const socket = new WebSocket("wss://your-domain.com:2053?webSocketToken=YOUR_TOKEN");

socket.onopen = () => console.log("✅ Connected");
socket.onmessage = (e) => console.log("📩 Message received:", e.data);
socket.onerror = (e) => console.error("❌ Error:", e);
```

---

## 🔗 AVideo Integration

- This server is designed to be called by the `YPTSocket` plugin inside AVideo.
- Place this project inside the plugin folder:  
  `plugin/YPTSocket/AVideo-Socket/`
- AVideo will automatically handle token generation and client-side WebSocket connection logic.
- Make sure the plugin is enabled and configured properly in your AVideo system.

---

## 📄 License

MIT

---

## 👤 Author

**Daniel Neto**  
Master in Computer Sciences  
PHP ZEND Certified Engineer  
Maintainer of [AVideo](https://github.com/WWBN/AVideo)
```
