const { Server } = require("socket.io");
const PHPWorker = require("./PHPWorker");
const SocketMessageType = require("./SocketMessageType");
const logger = require('./logger');
class MessageHandler {
    constructor(io, socketDataObj, thisServerVersion, phpWorker = null) {
        this.io = io;
        this.clients = new Map();
        this.clientsByUser = new Map();
        this.decryptedInfoCache = new Map();
        this.phpWorker = phpWorker || new PHPWorker();
        this.pendingDecryptions = new Map();
        this.nextCacheCleanup = 0;
        this.maxPendingMessages = 256;
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
        socket.yptQueue = [];
        socket.yptReady = false;
        socket.yptProcessing = false;
        socket.yptDisconnected = false;
        socket.on("message", data => {
            if (socket.yptDisconnected) return;
            if (socket.yptQueue.length >= this.maxPendingMessages) {
                socket.emit('error', { message: 'Message queue full' });
                socket.disconnect();
                return;
            }
            socket.yptQueue.push(data);
            this.drainMessages(socket);
        });
        socket.on("disconnect", reason => {
            socket.yptDisconnected = true;
            this.onDisconnect(socket, reason);
        });
        socket.on("error", error => this.onError(socket, error));
        const urlParams = new URLSearchParams(socket.handshake.query);
        const webSocketToken = urlParams.get("webSocketToken");
        let page_title = urlParams.get("page_title") || "";
        try {
            page_title = decodeURIComponent(page_title);
        } catch (error) {
            // Other clients may send an already decoded title containing a literal %.
            this.debugLog('Page title is already decoded or contains an invalid escape');
        }

        if (!webSocketToken) {
            this.debugLog("Missing WebSocket token, disconnecting...");
            socket.emit("error", { message: "Missing WebSocket Token" });
            socket.disconnect();
            return;
        }

        this.getDecryptedInfo(webSocketToken, (clientData, error) => {
                if (!clientData || error) {
                    socket.yptQueue = [];
                    this.debugLog(`Invalid WebSocket Token. Disconnecting client: ${socket.id}`);
                    socket.emit("error", { message: error ? "Socket service temporarily unavailable" : "Invalid WebSocket Token" });
                    socket.disconnect();
                    return;
                }
                this.finishConnection(socket, clientData, page_title);
        });
    }

    drainMessages(socket) {
        if (!socket.yptReady || socket.yptProcessing || !socket.yptQueue.length) return;
        socket.yptProcessing = true;
        this.onMessage(socket, socket.yptQueue.shift(), () => {
            socket.yptProcessing = false;
            setImmediate(() => this.drainMessages(socket));
        });
    }

    getDecryptedInfo(token, callback) {
        const cached = this.getCachedDecryptedInfo(token);
        if (cached) {
            callback(cached);
            return;
        }
        if (this.pendingDecryptions.has(token)) {
            this.pendingDecryptions.get(token).push(callback);
            return;
        }
        this.pendingDecryptions.set(token, [callback]);
        this.phpWorker.send('getDecryptedInfo', { token }, (data, error) => {
            if (data && !error) this.setCachedDecryptedInfo(token, data);
            const callbacks = this.pendingDecryptions.get(token) || [];
            this.pendingDecryptions.delete(token);
            callbacks.forEach(cb => {
                try {
                    cb(data, error);
                } catch (callbackError) {
                    console.error('Socket validation callback failed:', callbackError.message);
                }
            });
        });
    }

    getCachedDecryptedInfo(token) {
        this.cleanupOldCache();
        const entry = this.decryptedInfoCache?.get(token);
        if (!entry) return null;
        if (Date.now() - entry.createdAt > 5 * 60 * 1000) {
            this.decryptedInfoCache.delete(token);
            return null;
        }
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
        if (now < this.nextCacheCleanup) return;
        this.nextCacheCleanup = now + 60000;
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
            users_id: Number(clientData.from_users_id) || 0,
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

        socket.clientInfo = clientInfo;
        socket.yptReady = true;
        // PHP senders may close immediately after emitting. Finish their accepted
        // messages, but never register a disconnected sender as an online viewer.
        if (socket.yptDisconnected) {
            this.drainMessages(socket);
            return;
        }
        this.clients.set(socket.id, clientInfo);
        this.indexClient(clientInfo);
        this.updateCounters(clientInfo, +1);
        socket.join('globalRoom');
        if (clientInfo.isAdmin) {
            socket.join("adminsRoom"); // Join only if admin
        }
        socket.emit('yptReady', { resourceId: socket.id });
        this.debugLog(`New client connected: ${clientInfo.user_name} (users_id=${clientInfo.users_id}) (ip=${clientInfo.ip}) ${page_title}`);

        const msg = { id: clientInfo.id, type: SocketMessageType.NEW_CONNECTION };
        if (this.shouldPropagateConnetcion(clientInfo)) {
            this.queueMessageToAll(msg, socket);
        }
        this.drainMessages(socket);
    }

    shouldPropagateConnetcion(clientInfo) {
        if (clientInfo.ip == '127.0.0.1') {
            this.debugLog('shouldPropagateConnetcion ip', clientInfo.ip);
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

            if ((!this.msgToAllQueue.length && !this.presenceDirty) || this.isSendingToAll) return;
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
            this.cachedUsersInfo = { users_id_online, users_uri };
            this.presenceDirty = false;

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
            this.io.to("globalRoom").except("adminsRoom").emit("message", publicMsg);
            // Emit to admins only (with users_uri)
            this.io.to("adminsRoom").emit("message", adminMsg);

            this.debugLog(`📤 Broadcast batch sent [${messagesToSend.length}] messages. 📈 Max simultaneous connections: ${this.maxConnections}`);

            this.isSendingToAll = false;
        }, this.MSG_TO_ALL_TIMEOUT);

    }


    /**
     * Handles incoming messages
     */
    onMessage(socket, rawData, done = () => {}) {
        try {
            let message = typeof rawData === "string" ? JSON.parse(rawData) : rawData;

            if (!message.webSocketToken && typeof message[0] === "string") {
                message = JSON.parse(message[0]);
            }
            if (!message.webSocketToken) {
                this.debugLog("onMessage ERROR: webSocketToken is empty", message);
                socket.emit("error", { message: "Missing WebSocket Token" });
                done();
                return;
            }

            this.getDecryptedInfo(message.webSocketToken, (clientData, error) => {
                try {
                    if (!clientData || error) {
                        socket.yptQueue = [];
                        this.debugLog(`Invalid message token from ${socket.id}`);
                        socket.emit("error", { message: error ? "Socket service temporarily unavailable" : "Invalid WebSocket Token" });
                        socket.disconnect();
                        return;
                    }
                    socket.clientInfo = { ...socket.clientInfo, ...clientData };
                    this.processIncomingMessage(socket, message);
                } catch (processingError) {
                    console.error('Error routing socket message:', processingError.message);
                    socket.emit('error', { message: 'Invalid message format' });
                } finally {
                    done();
                }
            });
        } catch (error) {
            console.error(`Error processing message from ${socket.id}:`, error);
            socket.emit("error", { message: "Invalid message format" });
            done();
        }
    }

    /**
     * Método auxiliar para lidar com a lógica do message
     * depois que já temos o clientData certo (sem poluir onMessage).
     */
    processIncomingMessage(socket, message) {
        // resourceId in an incoming message is the destination. Metadata describes
        // the sender and must not replace that destination before routing.
        const destinationResourceId = message.resourceId;
        message = this.addMetadataToMessage(message, socket);
        const clientData = socket.clientInfo;

        // Handle TESTING message type - echo back to sender
        if (message.msg === SocketMessageType.TESTING || message.type === SocketMessageType.TESTING) {
            this.msgToResourceId(message, socket.id, SocketMessageType.TESTING);
            return;
        }

        // Route message based on destination
        if (clientData.send_to_uri_pattern) {
            this.msgToSelfURI(message, clientData.send_to_uri_pattern);
        } else if (message.to_users_id) {
            this.msgToUsers_id(message, message.to_users_id);
        } else if (message.to_users_id == 0) {
            this.queueMessageToAll(message, socket);
        } else if (destinationResourceId) {
            this.msgToResourceId(message, destinationResourceId);
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



    indexClient(clientInfo) {
        const userId = Number(clientInfo.users_id);
        if (!this.clientsByUser.has(userId)) this.clientsByUser.set(userId, new Set());
        this.clientsByUser.get(userId).add(clientInfo.id);
    }

    unindexClient(clientInfo) {
        const userId = Number(clientInfo.users_id);
        const connections = this.clientsByUser.get(userId);
        if (!connections) return;
        connections.delete(clientInfo.id);
        if (!connections.size) this.clientsByUser.delete(userId);
    }

    msgToUsers_id(msg, users_id, type = "") {
        if (typeof users_id !== 'number' && typeof users_id !== 'string') return;
        if (typeof users_id === 'string' && !users_id.trim()) return;
        const targetUserId = Number(users_id);
        if (!Number.isSafeInteger(targetUserId) || targetUserId < 0) return;
        let count = 0;
        let totals;

        for (const id of this.clientsByUser.get(targetUserId) || []) {
            const clientInfo = this.clients.get(id);
            if (Number(clientInfo?.users_id) === targetUserId && clientInfo.socket) {
                if (!totals) totals = this.getTotals();
                const enrichedMsg = {
                    ...msg,
                    type: msg.type || type,
                    autoUpdateOnHTML: {
                        ...msg.autoUpdateOnHTML,
                        ...totals,
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

        this.debugLog(`📨 msgToUsers_id: sent to ${count} client(s) with users_id=${users_id}`);
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

        this.debugLog(`📬 msgToSelfURI: sent to (${count}) clients pattern="${strippedPattern}" type="${type}"`);
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

    /**
     * Send message to all clients watching the same live stream
     */
    msgToAllSameLive(live_key, live_servers_id, msg, type = "") {
        if (!live_key) {
            console.warn(`⚠️ msgToAllSameLive: live_key is empty`);
            return;
        }

        const live_key_servers_id = `${live_key}_${live_servers_id || 0}`;
        let count = 0;
        const totals = this.getTotals();

        for (const clientInfo of this.clients.values()) {
            if (!clientInfo?.socket) continue;

            // Check if client is watching the same live stream
            if (clientInfo.live_key === live_key &&
                clientInfo.live_key_servers_id === live_key_servers_id) {
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
                    console.error(`❌ Failed to send to client ${clientInfo.id}:`, err.message);
                }
            }
        }

        this.debugLog(`📡 msgToAllSameLive: sent to ${count} client(s) watching live_key="${live_key}" (servers_id=${live_servers_id})`);
    }

    getUsersInfo() {
        if (process.env.DEBUG_LOGS === '1') logger.logStart("getUsersInfo");

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

        if (process.env.DEBUG_LOGS === '1') logger.logEnd("getUsersInfo");
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
        if (this.currentTotals) return this.currentTotals;
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

        this.currentTotals = totals;
        return totals;
    }


    updateCounters(client, delta) {
        this.currentTotals = null;
        this.cachedTotals = null;
        this.cachedUsersInfo = null;
        this.presenceDirty = true;
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
        if (!disconnectedClient) return;
        this.clients.delete(socket.id);
        this.unindexClient(disconnectedClient);
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
