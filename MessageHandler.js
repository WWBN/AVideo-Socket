const { Server } = require("socket.io");
const PHPWorker = require("./PHPWorker");
const SocketMessageType = require("./SocketMessageType");

class MessageHandler {
    constructor(io) {
        this.io = io;
        this.clients = new Map();
        this.timeout = 600000; // 10 minutes
        this.phpWorker = new PHPWorker();

        this.MSG_TO_ALL_TIMEOUT = 5000; // 5 seconds
        this.msgToAllQueue = [];
        this.isSendingToAll = false;
    }

    async init() {
        return new Promise((resolve, reject) => {
            this.phpWorker.send("SocketDataObj", {}, (response) => {
                if (response && response.serverVersion) {
                    this.socketDataObj = response;
                    console.log('✅ Server Version: ' + this.socketDataObj.serverVersion);

                    this.startPeriodicBroadcast();
                    resolve();
                } else {
                    console.warn('⚠️ socketDataObj.serverVersion not found in response:', response);
                    reject(new Error("Missing socketDataObj or serverVersion"));
                }
            });
        });
    }

    /**
     * Handles new client connections
     */
    onConnection(socket) {
        const urlParams = new URLSearchParams(socket.handshake.query);
        const webSocketToken = urlParams.get("webSocketToken");

        if (!webSocketToken) {
            console.warn("⚠️ Missing WebSocket token, disconnecting...");
            socket.emit("error", { message: "Missing WebSocket Token" });
            socket.disconnect();
            return;
        }

        this.phpWorker.send("getDecryptedInfo", { token: webSocketToken }, (clientData) => {
            if (!clientData) {
                console.warn(`⚠️ Invalid WebSocket Token. Disconnecting client: ${socket.id}`);
                socket.emit("error", { message: "Invalid WebSocket Token" });
                socket.disconnect();
                return;
            }

            const clientInfo = {
                socket,
                id: socket.id,
                users_id: clientData.from_users_id || 0,
                user_name: clientData.user_name || "unknown",
                isAdmin: clientData.isAdmin || false,
                videos_id: clientData.videos_id || 0,
                live_key: clientData.live_key || "",
                live_servers_id: clientData.live_servers_id || 0,
                selfURI: clientData.selfURI,
                yptDeviceId: clientData.yptDeviceId || "",
                connectedAt: Date.now(),
            };

            this.clients.set(socket.id, clientInfo);
            socket.clientInfo = clientInfo;
            console.log(`✅ New client connected: ${clientInfo.user_name} (users_id=${clientInfo.users_id})`);

            socket.on("message", (data) => this.onMessage(socket, data));
            socket.on("disconnect", (reason) => this.onDisconnect(socket, reason));
            socket.on("error", (error) => this.onError(socket, error));
            socket.on("ping", () => socket.emit("pong"));

            this.setTimeout(socket);
            const msg = { id: clientInfo.id, type: SocketMessageType.NEW_CONNECTION };
            this.queueMessageToAll(msg, socket);
        });
    }

    /**
     * Queue message to be sent to all clients
     */
    queueMessageToAll(msg, socket) {
        const withMeta = this.addMetadataToMessage(msg, socket);
        this.msgToAllQueue.push(withMeta);
    }

    /**
     * Periodically broadcast queued messages
     */
    startPeriodicBroadcast() {
        setInterval(() => {
            if (this.msgToAllQueue.length === 0 || this.isSendingToAll) return;

            this.isSendingToAll = true;

            const messagesToSend = [...this.msgToAllQueue];
            this.msgToAllQueue = [];

            const batchedMsg = {
                type: SocketMessageType.MSG_BATCH,
                messages: messagesToSend,
                timestamp: Date.now()
            };

            // no socket available here, send without extra client info
            const withMeta = this.addMetadataToMessage(batchedMsg);

            console.log(`📢 Broadcasting batch of ${messagesToSend.length} messages.`);
            this.io.emit("message", withMeta);

            this.isSendingToAll = false;
        }, this.MSG_TO_ALL_TIMEOUT);
    }

    /**
     * Handles incoming messages
     */
    onMessage(socket, rawData) {
        try {
            let message = typeof rawData === "string" ? JSON.parse(rawData) : rawData;

            if (!message.webSocketToken) {
                console.warn("⚠️ onMessage ERROR: webSocketToken is empty");
                socket.emit("error", { message: "Missing WebSocket Token" });
                return;
            }

            this.phpWorker.send("getDecryptedInfo", { token: message.webSocketToken }, (clientData) => {
                if (!clientData) {
                    console.warn(`⚠️ Invalid message token from ${socket.id}`);
                    socket.emit("error", { message: "Invalid WebSocket Token" });
                    socket.disconnect();
                    return;
                }

                socket.clientInfo = {
                    ...socket.clientInfo,
                    ...clientData
                };

                message = this.addMetadataToMessage(message, socket);

                if (clientData.send_to_uri_pattern) {
                    this.msgToSelfURI(message, clientData.send_to_uri_pattern);
                } else if (message.resourceId) {
                    this.msgToResourceId(message, message.resourceId);
                } else if (message.to_users_id) {
                    this.msgToUsers_id(message, message.to_users_id);
                } else if (message.json?.redirectLive) {
                    this.msgToAllSameLive(message.json.redirectLive.live_key, message.json.redirectLive.live_servers_id, message);
                } else {
                    this.queueMessageToAll(message, socket);
                }

                this.setTimeout(socket);
            });
        } catch (error) {
            console.error(`❌ Error processing message from ${socket.id}:`, error);
            socket.emit("error", { message: "Invalid message format" });
        }
    }

    /**
     * Add metadata to message from socket
     */
    addMetadataToMessage(msg, socket = null) {
        const totals = this.getTotals();
        const usedBytes = process.memoryUsage().heapUsed;
        const usedHuman = this.humanFileSize(usedBytes, false, 2);

        const clientInfo = socket?.clientInfo || {};

        msg.users_id = clientInfo.users_id || 0;
        msg.videos_id = clientInfo.videos_id || 0;
        msg.live_key = clientInfo.live_key || "";
        msg.webSocketServerVersion = this.socketDataObj.serverVersion;
        msg.isAdmin = clientInfo.isAdmin || false;

        msg.autoUpdateOnHTML = {
            ...totals,
            socket_mem: usedHuman,
            socket_resourceId: clientInfo.id || null,
            webSocketServerVersion: msg.webSocketServerVersion
        };

        return msg;
    }

    humanFileSize(bytes, si = false, dp = 1) {
        const thresh = si ? 1000 : 1024;
        if (Math.abs(bytes) < thresh) {
            return bytes + ' B';
        }
        const units = si
            ? ['kB','MB','GB','TB','PB','EB','ZB','YB']
            : ['KiB','MiB','GiB','TiB','PiB','EiB','ZiB','YiB'];
        let u = -1;
        const r = 10**dp;

        do {
            bytes /= thresh;
            ++u;
        } while (Math.round(Math.abs(bytes) * r) / r >= thresh && u < units.length - 1);

        return bytes.toFixed(dp) + ' ' + units[u];
    }

    getTotals() {
        const total_users_unique_users = new Set([...this.clients.values()].map(c => c.users_id)).size;
        return {
            total_users_online: this.clients.size,
            total_users_unique_users,
            total_devices_online: total_users_unique_users
        };
    }

    onDisconnect(socket, reason) {
        const disconnectedClient = this.clients.get(socket.id);
        this.clients.delete(socket.id);

        const msg = { id: socket.id, type: SocketMessageType.NEW_DISCONNECTION, reason };
        this.queueMessageToAll(msg, socket);
    }

    onError(socket, error) {
        console.error(`🚨 Error on ${socket.id}:`, error);
    }

    setTimeout(socket) {
        if (socket.timeout) clearTimeout(socket.timeout);
        socket.timeout = setTimeout(() => socket.disconnect(), this.timeout);
    }
}

module.exports = MessageHandler;
