const WebSocket = require("ws");

// Get WebSocket URL from command-line argument
let webSocketURL = process.argv[2];

console.log("🔍 Debugging: Starting WebSocket test script...");

// Function to test WebSocket connection
function testWebSocketConnection(url) {
    console.log(`\n🔄 Attempting to connect to WebSocket: ${url}\n`);

    try {
        const ws = new WebSocket(url, {
            rejectUnauthorized: false, // Allow self-signed SSL certificates
        });

        ws.on("open", () => {
            console.log("✅ Connection successful!");
            ws.send(JSON.stringify({ type: "ping" })); // Send a test message
        });

        ws.on("message", (data) => {
            console.log("📩 Message received:", data.toString());
        });

        ws.on("error", (err) => {
            console.error("❌ Connection failed:", err.message);
        });

        ws.on("close", (code, reason) => {
            console.warn(`⚠️ Connection closed: Code ${code}, Reason: ${reason || "No reason provided"}`);
        });

        // Close connection after 5 seconds
        setTimeout(() => {
            console.log("🔌 Closing test connection...");
            ws.close();
        }, 5000);

    } catch (error) {
        console.error("❌ Fatal Error:", error);
    }
}

// If a WebSocket URL is provided, test it directly
if (webSocketURL) {
    console.log(`🔍 Using provided WebSocket URL: ${webSocketURL}`);
    testWebSocketConnection(webSocketURL);
} else {
    console.log("\n📡 Retrieving WebSocket URL from the database...");

    // Import MySQL only if needed
    const { getPluginData } = require("./mysql");

    getPluginData("YPTSocket", (err, pluginData) => {
        if (err || !pluginData) {
            console.error("❌ Failed to retrieve WebSocket details from the database:", err);
            process.exit(1);
        }

        webSocketURL = `wss://${pluginData.host}:${pluginData.port}`;
        console.log(`✅ Retrieved WebSocket URL: ${webSocketURL}`);
        testWebSocketConnection(webSocketURL);
    });
}
