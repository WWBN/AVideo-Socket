const { Server } = require("socket.io");
const PHPWorker = require("./PHPWorker");
const SocketMessageType = require("./SocketMessageType");
class MessageHandler {
    constructor(io, socketDataObj, thisServerVersion) {
        this.io = io;
        this.clients = new Map();
        this.timeout = 600000;
        this.phpWorker = new PHPWorker();
        this.socketDataObj = socketDataObj;
        this.thisServerVersion = thisServerVersion;

        this.MSG_TO_ALL_TIMEOUT = 5000;
        this.msgToAllQueue = [];
        this.isSendingToAll = false;

        this.clientsInVideos = {};
        this.clientsInLives = {};
        this.clientsInLivesLinks = {};
        this.clientsInChatsRooms = {};
        this.clientsLoggedConnections = {};

        this.itemsToCheck = [
            { parameter: 'clientsLoggedConnections', index: 'users_id', class_prefix: '' },
            { parameter: 'clientsInVideos', index: 'videos_id', class_prefix: 'total_on_videos_id_' },
            { parameter: 'clientsInLives', index: 'live_key_servers_id', class_prefix: 'total_on_live_' },
            { parameter: 'clientsInLivesLinks', index: 'liveLink', class_prefix: 'total_on_live_links_id_' },
            { parameter: 'clientsInChatsRooms', index: 'room_users_id', class_prefix: '' }
        ];
    }

    async init() {
        this.startPeriodicBroadcast();
        return Promise.resolve();
    }

    /**
     * Handles new client connections
     */
    onConnection(socket) {
        const urlParams = new URLSearchParams(socket.handshake.query);
        const webSocketToken = urlParams.get("webSocketToken");
        const page_title = decodeURIComponent(urlParams.get("page_title") || "");

        //console.log('onConnection', page_title);
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
                ip: clientData.ip || 0,
                users_id: clientData.from_users_id || 0,
                user_name: clientData.user_name || "Unknown",
                isAdmin: clientData.isAdmin || false,
                videos_id: clientData.videos_id || 0,
                live_key: clientData.live_key || "",
                live_servers_id: clientData.live_servers_id || 0,
                selfURI: clientData.selfURI,
                yptDeviceId: clientData.yptDeviceId || "",
                connectedAt: Date.now(),
                page_title: page_title || "",
                DecryptedInfo: clientData,
            };

            this.clients.set(socket.id, clientInfo);
            this.updateCounters(clientInfo, +1);

            socket.clientInfo = clientInfo;
            console.log(`✅ New client connected: ${clientInfo.user_name} (users_id=${clientInfo.users_id}) (ip=${clientInfo.ip}) ${page_title}`);

            socket.on("message", (data) => this.onMessage(socket, data));
            socket.on("disconnect", (reason) => this.onDisconnect(socket, reason));
            socket.on("error", (error) => this.onError(socket, error));
            socket.on("ping", () => socket.emit("pong"));

            const connectedClient = this.clients.get(socket.id);
            //console.log('connectedClient', connectedClient.DecryptedInfo);
            const msg = { id: clientInfo.id, type: SocketMessageType.NEW_CONNECTION };
            //console.log(msg);
            if (this.shouldPropagateConnetcion(connectedClient)) {
                this.queueMessageToAll(msg, socket);
            }
        });
    }

    shouldPropagateConnetcion(clientInfo) {
        if (clientInfo.ip == '127.0.0.1') {
            console.log('shouldPropagateConnetcion ip', clientInfo.ip);
            return false;
        }
        return true;
    }

    /**
     * Queue message to be sent to all clients
     */
    queueMessageToAll(msg, socket) {
        console.log(`📢 ADD to Broadcast`, (typeof msg.type == 'undefined') ? ((typeof msg.callback == 'undefined') ? msg : msg.callback) : msg.type);
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

            if (!message.webSocketToken && typeof message[0] === "string") {
                message = JSON.parse(message[0]);
            }

            if (!message.webSocketToken) {
                console.warn("⚠️ onMessage ERROR: webSocketToken is empty", message);
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

    msgToUsers_id(msg, users_id, type = "") {
        let count = 0;

        for (const clientInfo of this.clients.values()) {
            if (clientInfo?.users_id === users_id && clientInfo.socket) {
                const enrichedMsg = {
                    ...msg,
                    type: msg.type || type,
                    autoUpdateOnHTML: {
                        ...msg.autoUpdateOnHTML,
                        ...this.getTotals(),
                        socket_resourceId: clientInfo.id,
                    }
                };

                try {
                    clientInfo.socket.emit("message", enrichedMsg);
                    count++;
                } catch (err) {
                    console.error(`❌ Failed to send message to users_id ${users_id} (${clientInfo.id}):`, err.message);
                }
            }
        }

        console.log(`📨 msgToUsers_id: sent to ${count} client(s) with users_id=${users_id}`);
    }


    msgToSelfURI(msg, pattern, type = "") {
        if (!pattern) return false;

        // Remove leading and trailing slashes
        const strippedPattern = pattern.replace(/^\/|\/$/g, "");

        let count = 0;
        let regex;

        try {
            regex = new RegExp(strippedPattern);
        } catch (e) {
            console.warn(`❌ Invalid regex pattern: "${pattern}"`, e.message);
            return false;
        }

        const totals = this.getTotals();

        for (const clientInfo of this.clients.values()) {
            if (!clientInfo?.socket || !clientInfo.selfURI) continue;

            if (regex.test(clientInfo.selfURI)) {
                count++;

                const enrichedMsg = {
                    ...msg,
                    type: msg.type || type,
                    autoUpdateOnHTML: {
                        ...(msg.autoUpdateOnHTML || {}),
                        ...totals,
                        socket_resourceId: clientInfo.id,
                    },
                };

                try {
                    clientInfo.socket.emit("message", enrichedMsg);
                } catch (err) {
                    console.error(`❌ Emit failed for ${clientInfo.id}:`, err.message);
                }
            }
        }

        console.log(`📬 msgToSelfURI: sent to (${count}) clients pattern="${strippedPattern}" type="${type}"`);
    }


    msgToResourceId(msg, resourceId, type = "", totals = null) {
        const client = this.clients.get(resourceId);
        if (!client || !client.socket) {
            console.warn(`⚠️ msgToResourceId: client with resourceId "${resourceId}" not found or has no socket.`);
            return;
        }

        const enrichedMsg = {
            ...msg,
            type: msg.type || type,
            autoUpdateOnHTML: {
                ...msg.autoUpdateOnHTML,
                ...(totals || this.getTotals())
            }
        };

        try {
            client.socket.emit("message", enrichedMsg);
            //console.log(`📤 Message sent to resourceId=${resourceId} (${client.user_name || "unknown"})`);
        } catch (err) {
            console.error(`❌ Failed to send message to resourceId ${resourceId}:`, err.message);
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

        // Estrutura de users_id_online
        const users_id_online = {};
        const users_uri = {};

        for (const client of this.clients.values()) {
            if (!Number.isInteger(client.users_id)) {
                continue;
            }

            // Preenche users_id_online
            users_id_online[client.users_id] = {
                users_id: client.users_id,
                resourceId: client.id,
                identification: client.user_name,
                selfURI: client.selfURI,
                page_title: client.page_title || ""
            };

            // Preenche users_uri
            const userID = client.users_id;
            const deviceID = client.yptDeviceId || 'unknown';
            const clientID = client.id;

            if (!users_uri[userID]) {
                users_uri[userID] = {};
            }
            if (!users_uri[userID][deviceID]) {
                users_uri[userID][deviceID] = {};
            }

            users_uri[userID][deviceID][clientID] = {
                users_id: client.users_id,
                user_name: client.user_name,
                sentFrom: client.DecryptedInfo?.sentFrom || '',
                ip: client.ip,
                selfURI: client.selfURI,
                page_title: client.page_title || "",
                client: {
                    browser: client.DecryptedInfo?.browser || '',
                    os: client.DecryptedInfo?.os || ''
                },
                location: client.DecryptedInfo?.location || null,
                resourceId: client.id
            };
        }

        // Metadados principais
        msg.users_id = clientInfo.users_id || 0;
        msg.videos_id = clientInfo.videos_id || 0;
        msg.live_key = clientInfo.live_key || "";
        msg.webSocketServerVersion = `${this.socketDataObj.serverVersion}.${this.thisServerVersion}`;
        msg.isAdmin = clientInfo.isAdmin || false;
        msg.resourceId = clientInfo.id || null;
        msg.ResourceID = clientInfo.id || null;

        // Inclusão das listas
        msg.users_id_online = users_id_online;
        msg.users_uri = users_uri;

        msg.autoUpdateOnHTML = {
            ...totals,
            socket_mem: usedHuman,
            socket_resourceId: clientInfo.id || null,
            webSocketServerVersion: msg.webSocketServerVersion,
        };

        return msg;
    }


    humanFileSize(bytes, si = false, dp = 1) {
        const thresh = si ? 1000 : 1024;
        if (Math.abs(bytes) < thresh) {
            return bytes + ' B';
        }
        const units = si
            ? ['kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
            : ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'];
        let u = -1;
        const r = 10 ** dp;

        do {
            bytes /= thresh;
            ++u;
        } while (Math.round(Math.abs(bytes) * r) / r >= thresh && u < units.length - 1);

        return bytes.toFixed(dp) + ' ' + units[u];
    }

    getTotals() {
        const uniqueUsers = new Set(
            [...this.clients.values()].map(c => `${c.users_id}_${c.yptDeviceId}`)
        );
        const total_users_unique_users = uniqueUsers.size;


        const totals = {
            total_users_online: this.clients.size,
            total_users_unique_users,
            total_devices_online: total_users_unique_users,
        };

        this.itemsToCheck.forEach(({ parameter, class_prefix }) => {
            const target = this[parameter];
            if (!target) return;

            for (const key in target) {
                if (!key || key === '_0' || key === '_') continue;
                const index = `${class_prefix}${key}`;
                totals[index] = target[key];
            }
        });

        return totals;
    }


    updateCounters(client, delta) {
        this.itemsToCheck.forEach(({ parameter, index }) => {
            const key = client[index];
            if (!key) return;

            if (!this[parameter][key]) {
                this[parameter][key] = 0;
            }

            this[parameter][key] += delta;

            if (this[parameter][key] <= 0) {
                delete this[parameter][key];
            }
        });
    }


    onDisconnect(socket, reason) {
        const disconnectedClient = this.clients.get(socket.id);
        this.clients.delete(socket.id);
        this.updateCounters(disconnectedClient, -1);

        //console.log('disconnectedClient', disconnectedClient.DecryptedInfo);
        const msg = { id: socket.id, type: SocketMessageType.NEW_DISCONNECTION, reason };

        if (this.shouldPropagateConnetcion(disconnectedClient)) {
            this.queueMessageToAll(msg, socket);
        }
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
