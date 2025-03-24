const fs = require("fs");
const https = require("https");
const socketIo = require("socket.io");
const figlet = require("figlet");
const readline = require("readline");
const { execSync } = require("child_process");
const { getPluginData } = require("./mysql");
const MessageHandler = require("./MessageHandler");

const thisServerVersion = '1';
var serverVersion = '0';
var phpSocketDataObj = {};

const path = require("path");

if (process.pkg) {
    const fontFile = path.join(__dirname, 'node_modules/figlet/fonts/Standard.flf');
    const fontContent = fs.readFileSync(fontFile, 'utf-8');
    figlet.parseFont('Standard', fontContent);
}

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

function killProcessOnPort(port) {
    try {
        const pid = execSync(`lsof -t -i:${port}`).toString().trim();
        if (pid) {
            console.warn(`⚠️ Port ${port} is in use by PID: ${pid}`);
            if (FORCE_KILL) {
                console.log("☠️ Force kill mode enabled. Killing process...");
                execSync(`kill -9 ${pid}`);
                console.log(`✅ Killed process using port ${port}`);
                return true;
            }

            return askQuestion("❓ Port is in use. Do you want to kill the process? (y/n): ")
                .then(answer => {
                    if (answer === 'y') {
                        execSync(`kill -9 ${pid}`);
                        console.log(`✅ Killed process using port ${port}`);
                        return true;
                    } else {
                        console.log("❌ Aborting. Port is still in use.");
                        process.exit(1);
                    }
                });
        }
    } catch (err) {
        console.error(`❌ Failed to identify or kill process using port ${port}:`, err.message);
        process.exit(1);
    }
}

function startServer(pluginData) {
    const sslOptions = {
        key: fs.readFileSync(pluginData.server_key_file.replace(/\\/g, "")),
        cert: fs.readFileSync(pluginData.server_crt_file.replace(/\\/g, "")),
    };

    const server = https.createServer(sslOptions);
    const io = socketIo(server, { cors: { origin: "*" } });

    const messageHandler = new MessageHandler(io, phpSocketDataObj);

    messageHandler.init().then(() => {
        io.on("connection", (socket) => {
            messageHandler.onConnection(socket);

            socket.on("error", (error) => {
                console.error(`🚨 Error on ${socket.id}:`, error);
            });

            socket.on("ping", () => {
                console.log(`🏓 Ping received from ${socket.id}`);
                socket.emit("pong");
            });
        });

        server.listen(pluginData.port || 2053, pluginData.uri || "0.0.0.0", () => {
            console.clear();

            figlet.text("YPTSocket", { font: "Standard" }, (err, data) => {
                if (!err) console.log(data);

                console.log("\n🚀 Secure WebSocket Server is Running!");
                console.log(`📡 Listening on: wss://${pluginData.host}:${pluginData.port}`);
                console.log(`🔐 SSL Certificate: ${pluginData.server_crt_file.replace(/\\/g, "")}`);
                console.log(`🔑 SSL Key: ${pluginData.server_key_file.replace(/\\/g, "")}`);
                console.log("📅 Timestamp: " + new Date().toLocaleString());
                console.log("🖥️ Server Version:", serverVersion);
                console.log("\nWaiting for connections...");
            });

        });

        server.on("error", async (err) => {
            if (err.code === "EADDRINUSE") {
                console.error(`❌ Port ${pluginData.port} is already in use.`);

                const killed = await killProcessOnPort(pluginData.port);
                if (killed) {
                    setTimeout(() => startServer(pluginData), 1000);
                }
            } else {
                console.error("❌ Server error:", err.message);
                process.exit(1);
            }
        });
    }).catch(err => {
        console.error("❌ Failed to initialize MessageHandler:", err.message);
    });
}

// Load plugin data and start
getPluginData("YPTSocket", (err, pluginData) => {
    if (err || !pluginData) {
        console.error("❌ Failed to fetch plugin data or plugin not found:", err);
        process.exit(1);
    }

    console.log("✅ Plugin Data Loaded Successfully");

    const PHPWorker = require("./PHPWorker");
    const phpWorker = new PHPWorker();

    phpWorker.send("SocketDataObj", {}, (socketDataObj) => {
        if (!socketDataObj || !socketDataObj.serverVersion) {
            console.error("❌ Failed to get SocketDataObj");
            process.exit(1);
        }

        console.log("✅ SocketDataObj Loaded:", socketDataObj.serverVersion);
        phpSocketDataObj = socketDataObj;
        serverVersion = `${socketDataObj.serverVersion}.${thisServerVersion}`;
        startServer(pluginData);
    });
});
