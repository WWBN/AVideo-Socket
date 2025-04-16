const fs = require("fs");
const https = require("https");
const socketIo = require("socket.io");
const readline = require("readline");
const { execSync } = require("child_process");
const path = require("path");

const tls = require("tls");
const mysqlSetup = require("./mysql");
const MessageHandler = require("./MessageHandler");
const logger = require('./logger');
const serverStartTime = Date.now();

const thisServerVersion = '45';
let serverVersion = '0';
let phpSocketDataObj = {};

const FORCE_KILL = process.argv.includes("--force-kill-port");

function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans.trim().toLowerCase());
    }));
}

async function killProcessOnPort(port) {
    try {
        const pid = execSync(`lsof -t -i:${port}`).toString().trim();
        if (pid) {
            console.warn(`⚠️ Port ${port} is used by PID: ${pid}`);
            if (FORCE_KILL) {
                console.log("☠️ Force kill enabled. Terminating process...");
                execSync(`kill -9 ${pid}`);
                console.log(`✅ Killed process using port ${port}`);
                return true;
            }

            const answer = await askQuestion("❓ Port in use. Kill the process? (y/n): ");
            if (answer === 'y') {
                execSync(`kill -9 ${pid}`);
                console.log(`✅ Killed process using port ${port}`);
                return true;
            } else {
                console.log("❌ Aborting. Port is still in use.");
                process.exit(1);
            }
        }
    } catch (err) {
        console.error(`❌ Failed to identify or kill process on port ${port}:`, err.message);
        process.exit(1);
    }
    return false;
}

async function startServer(pluginData) {
    const crtPath = pluginData.server_crt_file.replace(/\\/g, "");
    const keyPath = pluginData.server_key_file.replace(/\\/g, "");
    const fullchainPath = path.join(path.dirname(crtPath), "fullchain.pem");

    let finalCrtPath = crtPath;
    if (fs.existsSync(fullchainPath)) {
        console.log("✅ Using fullchain.pem for SSL certificate.");
        finalCrtPath = fullchainPath;
    } else {
        console.log(`⚠️ fullchain.pem not found, using fallback: ${crtPath}`);
    }

    const certPem = fs.readFileSync(finalCrtPath, "utf8");
    const keyPem = fs.readFileSync(keyPath, "utf8");

    // Optional: display certificate details
    try {
        const cn = certPem.match(/Subject:.*?CN\s*=\s*([^\n\/]+)/i);
        const issuer = certPem.match(/Issuer:.*?CN\s*=\s*([^\n\/]+)/i);
        const validFrom = certPem.match(/Not Before:\s*(.+)/i);
        const validTo = certPem.match(/Not After\s*:\s*(.+)/i);

        console.log("🔐 SSL Certificate Info:");
        if (cn) console.log(` - Common Name (CN): ${cn[1]}`);
        if (issuer) console.log(` - Issuer          : ${issuer[1]}`);
        if (validFrom) console.log(` - Valid From      : ${validFrom[1]}`);
        if (validTo) console.log(` - Valid To        : ${validTo[1]}`);

        const isSelfSigned = cn && issuer && cn[1] === issuer[1];
        console.log(` - Self-Signed     : ${isSelfSigned ? "❌ Yes" : "✅ No"}`);
    } catch (err) {
        console.error("❌ Failed to analyze certificate:", err.message);
    }

    const sslOptions = { key: keyPem, cert: certPem };

    const server = https.createServer(sslOptions);
    const io = socketIo(server, { cors: { origin: "*" } });

    const messageHandler = new MessageHandler(io, phpSocketDataObj, thisServerVersion);
    logger.setClientCounter(() => messageHandler.clients.size);

    await messageHandler.init();

    io.on("connection", (socket) => {
        messageHandler.onConnection(socket);

        socket.on("error", (error) => {
            console.error(`🚨 Socket error ${socket.id}:`, error);
        });

        socket.on("ping", () => {
            //console.log(`🏓 Ping from ${socket.id}`);
            socket.emit("pong");
        });
    });

    server.listen(pluginData.port || 2053, pluginData.uri || "0.0.0.0", () => {

        console.clear();

        console.log("\n==== YPTSocket ====\n");
        console.log("🚀 WebSocket Secure Server is running!");
        console.log(`📡 Listening on: wss://${pluginData.host}:${pluginData.port}`);
        console.log(`🔐 SSL Cert   : ${pluginData.server_crt_file.replace(/\\/g, "")}`);
        console.log(`🔑 SSL Key    : ${pluginData.server_key_file.replace(/\\/g, "")}`);
        console.log("📅 Time       :", new Date().toLocaleString());
        console.log("🖥️ Version    :", serverVersion);
        console.log("\nAwaiting connections...");

    });

    server.on("error", async (err) => {
        if (err.code === "EADDRINUSE") {
            console.error(`❌ Port ${pluginData.port} is already in use.`);
            const killed = await killProcessOnPort(pluginData.port);
            if (killed) setTimeout(() => startServer(pluginData), 1000);
        } else {
            console.error("❌ Server error:", err.message);
            process.exit(1);
        }
    });

    server.on("clientError", (err, socket) => {
        console.warn("⚠️ HTTPS client error:", err.message);
        socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });
}

async function main() {
    console.log("✅ Starting version", thisServerVersion);

    // 1. Connect to MySQL pool
    await mysqlSetup.connectToMySQL();

    // 2. Load plugin data
    const pluginData = await mysqlSetup.getPluginData("YPTSocket");
    if (!pluginData) {
        console.error("❌ Plugin data not found.");
        process.exit(1);
    }

    console.log("✅ Plugin data loaded.");

    const PHPWorker = require("./PHPWorker");
    const phpWorker = new PHPWorker();

    // Clean exit handler
    process.on('exit', () => {
        console.log("🚪 Process exit. Closing PHP worker...");
        phpWorker.close();
    });
    process.on('SIGINT', () => {
        console.log("🛑 SIGINT detected.");
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        console.log("🛑 SIGTERM detected.");
        process.exit(0);
    });
    process.on('uncaughtException', (err) => {
        console.error("💥 Uncaught Exception:", err);
        if (err.code === 'ECONNRESET') {
            console.warn("⚠️ Ignoring ECONNRESET (connection forcibly closed by peer)");
            return;
        }
        process.exit(1);
    });

    // 3. Load server metadata from PHP
    phpWorker.send("SocketDataObj", {}, (socketDataObj) => {
        if (!socketDataObj || !socketDataObj.serverVersion) {
            console.error("❌ Failed to load SocketDataObj");
            process.exit(1);
        }

        console.log("✅ SocketDataObj Loaded:", socketDataObj.serverVersion);
        phpSocketDataObj = socketDataObj;
        serverVersion = `${socketDataObj.serverVersion}.${thisServerVersion}`;

        // 4. Start HTTPS + WebSocket server
        startServer(pluginData);
    });
}

main();
