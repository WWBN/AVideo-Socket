const { Server } = require("socket.io");
const PHPWorker = require("./PHPWorker");
const SocketMessageType = require("./SocketMessageType");
const logger = require('./logger');
class MessageHandler {
    constructor(io, socketDataObj, thisServerVersion) {
        this.io = io;
        this.clients = new Map();
        this.decryptedInfoCache = new Map();
        this.phpWorker = new PHPWorker();
        this.socketDataObj = socketDataObj;
        this.thisServerVersion = thisServerVersion;

        this.MSG_TO_ALL_TIMEOUT = 5000;
        this.cachedUsersInfo = this.getUsersInfo();
        this.msgToAllQueue = [];
        this.isSendingToAll = false;

        this.clientsInVideos = {};
        this.clientsInLives = {};
        this.clientsInLivesLinks = {};
        this.clientsInChatsRooms = {};
        this.clientsLoggedConnections = {};

        // List of counters to track per connection type
        this.itemsToCheck = [
            { parameter: 'clientsLoggedConnections', index: 'users_id', class_prefix: 'clientsLoggedConnections_' },
            { parameter: 'clientsInVideos', index: 'videos_id', class_prefix: 'total_on_videos_id_' },
            { parameter: 'clientsInLives', index: 'live_key_servers_id', class_prefix: 'total_on_live_' },
            { parameter: 'clientsInLivesLinks', index: 'liveLink', class_prefix: 'total_on_live_links_id_' },
            { parameter: 'clientsInChatsRooms', index: 'room_users_id', class_prefix: '' }
        ];
    }

    debugLog(...args) {
        if (process.env.DEBUG_LOGS === '1') {
            logger.log(...args);
        }
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

        if (!webSocketToken) {
            this.debugLog("Missing WebSocket token, disconnecting...");
            socket.emit("error", { message: "Missing WebSocket Token" });
            socket.disconnect();
            return;
        }

        socket.join('globalRoom');

        const cachedData = this.getCachedDecryptedInfo(webSocketToken);
        if (cachedData) {
            this.finishConnection(socket, cachedData, page_title);
        } else {
            this.phpWorker.send("getDecryptedInfo", { token: webSocketToken }, (clientData) => {
                if (!clientData) {
                    this.debugLog(`Invalid WebSocket Token. Disconnecting client: ${socket.id}`);
                    socket.emit("error", { message: "Invalid WebSocket Token" });
                    socket.disconnect();
                    return;
                }
                this.setCachedDecryptedInfo(webSocketToken, clientData);
                this.finishConnection(socket, clientData, page_title);
            });
        }
    }

    getCachedDecryptedInfo(token) {
        this.cleanupOldCache();
        const entry = this.decryptedInfoCache?.get(token);
        if (!entry) return null;
        return entry.data;
    }

    setCachedDecryptedInfo(token, clientData) {
        this.cleanupOldCache();
        const now = Date.now();
        this.decryptedInfoCache?.set(token, {
            data: clientData,
            createdAt: now
        });
    }

    cleanupOldCache() {
        const now = Date.now();
        const TTL = 5 * 60 * 1000;
        for (const [token, obj] of this.decryptedInfoCache) {
            if (now - obj.createdAt > TTL) {
                this.decryptedInfoCache.delete(token);
            }
        }
    }

    /**
     * Função auxiliar chamada depois de obter clientData (ou do cache, ou do PHP).
     */
    finishConnection(socket, clientData, page_title) {
        //console.log(clientData);
        const clientInfo = {
            socket,
            id: socket.id,
            ip: clientData.ip || 0,
            users_id: clientData.from_users_id || 0,
            user_name: clientData.user_name || "Unknown",
            isAdmin: clientData.isAdmin || false,
            videos_id: clientData.videos_id || 0,
            live_key: clientData.live_key?.key || "",
            live_servers_id: clientData.live_key?.live_servers_id || 0,
            live_key_servers_id: `${clientData.live_key?.key || ""}_${clientData.live_key?.live_servers_id || 0}`,
            selfURI: clientData.selfURI,
            yptDeviceId: clientData.yptDeviceId || "",
            connectedAt: Date.now(),
            page_title: page_title || "",
            DecryptedInfo: clientData,
            liveLink: clientData.live_key?.liveLink || "",
        };

        this.clients.set(socket.id, clientInfo);
        this.updateCounters(clientInfo, +1);
        socket.clientInfo = clientInfo;
        if (clientInfo.isAdmin) {
            socket.join("adminsRoom"); // Join only if admin
        }
        this.debugLog(`New client connected: ${clientInfo.user_name} (users_id=${clientInfo.users_id}) (ip=${clientInfo.ip}) ${page_title}`);

        socket.on("message", (data) => this.onMessage(socket, data));
        socket.on("disconnect", (reason) => this.onDisconnect(socket, reason));
        socket.on("error", (error) => this.onError(socket, error));

        const msg = { id: clientInfo.id, type: SocketMessageType.NEW_CONNECTION };
        if (this.shouldPropagateConnetcion(clientInfo)) {
            this.queueMessageToAll(msg, socket);
        }
    }

    shouldPropagateConnetcion(clientInfo) {
        if (clientInfo.ip == '127.0.0.1') {
            logger.log('shouldPropagateConnetcion ip', clientInfo.ip);
            return false;
        }
        return true;
    }

    /**
     * Queue message to be sent to all clients
     */
    queueMessageToAll(msg, socket) {
        //logger.log(`📢 ADD to Broadcast`, (typeof msg.type == 'undefined') ? ((typeof msg.callback == 'undefined') ? msg : msg.callback) : msg.type);
        const withMeta = this.addMetadataToMessage(msg, socket);
        this.msgToAllQueue.push(withMeta);
    }

    /**
     * Periodically broadcast queued messages
     */
    startPeriodicBroadcast() {
        setInterval(() => {
            this.cachedTotals = this.getTotals();

            const currentConnections = this.clients.size;
            if (!this.maxConnections || currentConnections > this.maxConnections) {
                this.maxConnections = currentConnections;
            }

            if (this.msgToAllQueue.length === 0 || this.isSendingToAll) return;
            this.isSendingToAll = true;

            const messagesToSend = [...this.msgToAllQueue];
            this.msgToAllQueue = [];

            const baseMsg = {
                type: SocketMessageType.MSG_BATCH,
                messages: messagesToSend,
                timestamp: Date.now(),
            };

            // Send message to all clients (globalRoom)
            const totals = this.cachedTotals || this.getTotals();
            const usedHuman = this.humanFileSize(process.memoryUsage().heapUsed);
            const { users_id_online, users_uri } = this.cachedUsersInfo || this.getUsersInfo();

            const publicMsg = {
                ...baseMsg,
                users_id_online,
                autoUpdateOnHTML: {
                    ...totals,
                    socket_mem: usedHuman,
                    webSocketServerVersion: `${this.socketDataObj.serverVersion}.${this.thisServerVersion}`,
                },
                webSocketServerVersion: `${this.socketDataObj.serverVersion}.${this.thisServerVersion}`,
            };

            const adminMsg = {
                ...publicMsg,
                users_uri
            };

            // Emit to global room (without users_uri)
            this.io.to("globalRoom").emit("message", publicMsg);
            // Emit to admins only (with users_uri)
            this.io.to("adminsRoom").emit("message", adminMsg);

            logger.log(`📤 Broadcast batch sent [${messagesToSend.length}] messages. 📈 Max simultaneous connections: ${this.maxConnections}`);

            this.isSendingToAll = false;
        }, this.MSG_TO_ALL_TIMEOUT);

        setInterval(() => {
            this.cachedUsersInfo = this.getUsersInfo();
        }, this.MSG_TO_ALL_TIMEOUT * 2);
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
                this.debugLog("onMessage ERROR: webSocketToken is empty", message);
                socket.emit("error", { message: "Missing WebSocket Token" });
                return;
            }

            const cachedData = this.getCachedDecryptedInfo(message.webSocketToken);
            if (cachedData) {
                socket.clientInfo = { ...socket.clientInfo, ...cachedData };
                this.processIncomingMessage(socket, message);
            } else {
                this.phpWorker.send("getDecryptedInfo", { token: message.webSocketToken }, (clientData) => {
                    if (!clientData) {
                        this.debugLog(`Invalid message token from ${socket.id}`);
                        socket.emit("error", { message: "Invalid WebSocket Token" });
                        socket.disconnect();
                        return;
                    }
                    this.setCachedDecryptedInfo(message.webSocketToken, clientData);
                    socket.clientInfo = { ...socket.clientInfo, ...clientData };
                    this.processIncomingMessage(socket, message);
                });
            }
        } catch (error) {
            console.error(`Error processing message from ${socket.id}:`, error);
            socket.emit("error", { message: "Invalid message format" });
        }
    }

    /**
     * Método auxiliar para lidar com a lógica do message
     * depois que já temos o clientData certo (sem poluir onMessage).
     */
    processIncomingMessage(socket, message) {
        message = this.addMetadataToMessage(message, socket);

        const clientData = socket.clientInfo;
        if (clientData.send_to_uri_pattern) {
            this.msgToSelfURI(message, clientData.send_to_uri_pattern);
        } else if (message.to_users_id) {
            this.msgToUsers_id(message, message.to_users_id);
        } else if (message.resourceId) {
            this.msgToResourceId(message, message.resourceId);
        } else if (message.json?.redirectLive) {
            this.msgToAllSameLive(
                message.json.redirectLive.live_key,
                message.json.redirectLive.live_servers_id,
                message
            );
        } else {
            this.queueMessageToAll(message, socket);
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

        logger.log(`📨 msgToUsers_id: sent to ${count} client(s) with users_id=${users_id}`);
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

        logger.log(`📬 msgToSelfURI: sent to (${count}) clients pattern="${strippedPattern}" type="${type}"`);
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
            //logger.log(`📤 Message sent to resourceId=${resourceId} (${client.user_name || "unknown"})`);
        } catch (err) {
            console.error(`❌ Failed to send message to resourceId ${resourceId}:`, err.message);
        }
    }

    getUsersInfo() {
        logger.logStart("getUsersInfo");

        const users_id_online_map = {};
        const users_uri = {};

        for (const client of this.clients.values()) {
            const userID = parseInt(client.users_id);

            if (!Number.isInteger(userID)) {
                continue;
            }

            // Preenche users_id_online apenas se ainda não existe
            if (!users_id_online_map[userID]) {
                users_id_online_map[userID] = {
                    users_id: userID,
                    resourceId: client.id,
                    identification: client.user_name,
                    selfURI: client.selfURI,
                    page_title: client.page_title || ""
                };
            }

            // Preenche users_uri
            const deviceID = client.yptDeviceId || 'unknown';
            const clientID = client.id;

            if (!users_uri[userID]) {
                users_uri[userID] = {};
            }
            if (!users_uri[userID][deviceID]) {
                users_uri[userID][deviceID] = {};
            }

            users_uri[userID][deviceID][clientID] = {
                users_id: userID,
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

        // Converte objeto para array de objetos únicos por users_id
        const users_id_online = Object.values(users_id_online_map);

        logger.logEnd("getUsersInfo");
        return { users_id_online, users_uri };
    }



    /**
     * Add metadata to message from socket
     */
    addMetadataToMessage(msg, socket = null) {
        msg.webSocketServerVersion = `${this.socketDataObj.serverVersion}.${this.thisServerVersion}`;

        const clientInfo = socket?.clientInfo || {};
        if (msg.type === 'MSG_BATCH') {
            const totals = this.cachedTotals || this.getTotals();
            const usedBytes = process.memoryUsage().heapUsed;
            const usedHuman = this.humanFileSize(usedBytes);
            const { users_id_online } = this.cachedUsersInfo || this.getUsersInfo();

            msg.users_id_online = users_id_online;
            msg.autoUpdateOnHTML = {
                ...totals,
                socket_mem: usedHuman,
                webSocketServerVersion: msg.webSocketServerVersion,
            };
            // Note: users_uri is not included here anymore, it is sent only in adminMsg inside startPeriodicBroadcast
        } else {
            msg.autoUpdateOnHTML = {
                socket_resourceId: clientInfo.id || null,
            };
            msg.users_id = clientInfo.users_id || 0;
            msg.videos_id = clientInfo.videos_id || 0;
            msg.live_key = clientInfo.live_key || "";
            msg.isAdmin = clientInfo.isAdmin || false;
            msg.resourceId = clientInfo.id || null;
            msg.ResourceID = clientInfo.id || null;
        }
        return msg;
    }

    humanFileSize(bytes) {
        const mb = bytes / 1024 / 1024;
        return mb.toFixed(1) + " MB";
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
            if (!class_prefix) return;
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

        //logger.log('disconnectedClient', disconnectedClient.DecryptedInfo);
        const msg = { id: socket.id, type: SocketMessageType.NEW_DISCONNECTION, reason };

        if (this.shouldPropagateConnetcion(disconnectedClient)) {
            this.queueMessageToAll(msg, socket);
        }
    }

    onError(socket, error) {
        console.error(`🚨 Error on ${socket.id}:`, error);
    }

}

module.exports = MessageHandler;
