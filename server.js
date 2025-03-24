const fs = require("fs");
const https = require("https");
const socketIo = require("socket.io");
const figlet = require("figlet");
const { getPluginData } = require("./mysql"); // Import MySQL function
const MessageHandler = require("./MessageHandler"); // Import MessageHandler

// Fetch plugin data for 'YPTSocket'
getPluginData("YPTSocket", (err, pluginData) => {
    if (err || !pluginData) {
        console.error("❌ Failed to fetch plugin data or plugin not found:", err);
        process.exit(1);
    }

    console.log("✅ Plugin Data Loaded Successfully");

    // Extract SSL Certificate paths from plugin data
    const sslOptions = {
        key: fs.readFileSync(pluginData.server_key_file.replace(/\\/g, "")), // Read SSL Key
        cert: fs.readFileSync(pluginData.server_crt_file.replace(/\\/g, "")), // Read SSL Certificate
    };

    // Create Secure HTTPS Server
    const server = https.createServer(sslOptions);
    const io = socketIo(server, { cors: { origin: "*" } });

    // Initialize Message Handler
    const messageHandler = new MessageHandler(io);

    messageHandler.init().then(() => {
        console.log("🚀 Secure WebSocket Server is Ready!");


        // **👀 FIX: Ensure `onMessage` is globally available**
        io.on("connection", (socket) => {
            //console.log(`🔗 New client connected: ${socket.id}`);
            messageHandler.onConnection(socket);

            // **🛠️ Global message listener**
            socket.on("message", (data) => {
                //console.log(`📩 Received global message from ${socket.id}:`, data);
                //messageHandler.onMessage(socket, data);
                //socket.emit("messageAck", { success: true });
            });

            // **🛠️ Global disconnect listener**
            socket.on("disconnect", (reason) => {
                //console.log(`❌ Client disconnected: ${socket.id} (Reason: ${reason})`);
                //messageHandler.onDisconnect(socket, reason);
            });

            // **🛠️ Global error listener**
            socket.on("error", (error) => {
                console.error(`🚨 Error on ${socket.id}:`, error);
            });

            // **🛠️ Ping-Pong to maintain connection health**
            socket.on("ping", () => {
                console.log(`🏓 Ping received from ${socket.id}`);
                socket.emit("pong");
            });
        });

        // Start Secure WebSocket Server
        server.listen(pluginData.port || 2053, pluginData.uri || "0.0.0.0", () => {
            console.clear();
            figlet("YPTSocket", (err, data) => {
                if (err) {
                    console.error("Figlet error:", err);
                    return;
                }
                console.log(data);
                console.log("\n🚀 Secure WebSocket Server is Running!");
                console.log(`📡 Listening on: wss://${pluginData.host}:${pluginData.port}`);
                console.log(`🔐 SSL Certificate: ${pluginData.server_crt_file}`);
                console.log(`🔑 SSL Key: ${pluginData.server_key_file}`);
                console.log("📅 Timestamp: " + new Date().toLocaleString());
                console.log("\nWaiting for connections...");
            });
        });
    }).catch(err => {
        console.error("❌ Failed to initialize MessageHandler:", err.message);
    });
});
