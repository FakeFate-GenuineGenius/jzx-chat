const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const AUTO_LOGOUT_MS = 30 * 60 * 1000;
const RECALL_WINDOW_MS = 2 * 60 * 1000;
const LOGS_DIR = path.join(__dirname, "logs");

// 从外部 JSON 文件动态读取 IP 黑名单
const BLACKLIST_FILE = path.join(__dirname, "blacklist.json");

function getBlacklistedIps() {
    try {
        if (fs.existsSync(BLACKLIST_FILE)) {
            const data = fs.readFileSync(BLACKLIST_FILE, "utf8");
            return JSON.parse(data);
        }
    } catch (error) {
        console.error("读取黑名单配置失败:", error);
    }
    return [];
}

// 任何页面的访问级别 IP 检测 (包含静态资源)
app.use((req, res, next) => {
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || "";
    const ipBlacklist = getBlacklistedIps();
    
    if (ipBlacklist.some(ip => clientIp.includes(ip))) {
        return res.status(403).send("<h2 style='text-align:center;margin-top:50px;'>由于违规行为，您的 IP 已被禁止访问本站点。</h2>");
    }
    next();
});

app.use(express.static("public"));

const rooms = new Map(); // roomCode -> { users: [], messages: [] }

function generateRoomCode(length = 6) {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < length; i += 1) {
        code += alphabet[crypto.randomInt(0, alphabet.length)];
    }
    return code;
}

function createRoomCode() {
    let roomCode = generateRoomCode();
    while (rooms.has(roomCode)) {
        roomCode = generateRoomCode();
    }
    return roomCode;
}

function getPublicUsers(room) {
    return room.users.map(({ disconnectTimer, ...user }) => user);
}

function getPublicMessages(room) {
    return room.messages.map(({ ...message }) => message);
}

function formatLogTime(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${year}年${month}月${day}日 ${hours}:${minutes}`;
}

function formatLogFileName(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}.log`;
}

function getChatLogFilePath(date = new Date()) {
    return path.join(LOGS_DIR, formatLogFileName(date));
}

function getLocalIPv4Addresses() {
    const addresses = [];
    const networkInterfaces = os.networkInterfaces();

    for (const interfaceName of Object.keys(networkInterfaces)) {
        const entries = networkInterfaces[interfaceName] || [];
        for (const entry of entries) {
            if (entry && entry.family === "IPv4" && !entry.internal) {
                addresses.push(entry.address);
            }
        }
    }

    return addresses;
}

function appendChatLogLine(line) {
    try {
        fs.appendFileSync(getChatLogFilePath(), `${line}\n`, "utf8");
    } catch (error) {
        console.error("写入聊天记录失败:", error);
    }
}

function recordChatEvent(roomCode, user, eventName, ip = "") {
    const ipStr = ip ? ` (${ip})` : "";
    appendChatLogLine(`[${formatLogTime()}] [${roomCode}] ${user}${ipStr} ${eventName}`);
}

function recordChatMessage(roomCode, speakerName, content, { recalled = false } = {}) {
    const statusText = recalled ? " (已撤回)" : "";
    appendChatLogLine(`[${formatLogTime()}] [${roomCode}] ${speakerName}: ${content}${statusText}`);
}

function emitRoomState(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;
    io.to(roomCode).emit("room-state", {
        roomCode,
        users: getPublicUsers(room),
        messages: getPublicMessages(room),
    });
}

function handleRoomDisbandTimer(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;

    if (room.users.length === 0) {
        if (room.disbandTimer) clearTimeout(room.disbandTimer);
        rooms.delete(roomCode);
        return;
    }

    if (room.users.length === 1) {
        if (!room.disbandTimer) {
            room.disbandTimer = setTimeout(() => {
                const r = rooms.get(roomCode);
                if (r && r.users.length <= 1) {
                    io.to(roomCode).emit("room-destroyed", { reason: "房间已被解散" });
                    rooms.delete(roomCode);
                    console.log("房间超时解散:", roomCode);
                }
            }, AUTO_LOGOUT_MS);
        }
    } else {
        if (room.disbandTimer) {
            clearTimeout(room.disbandTimer);
            room.disbandTimer = null;
        }
    }
}

function removeUser(roomCode, sessionId) {
    const room = rooms.get(roomCode);
    if (!room) return;

    const index = room.users.findIndex((user) => user.sessionId === sessionId);
    if (index === -1) return;

    const [removed] = room.users.splice(index, 1);
    if (removed.disconnectTimer) {
        clearTimeout(removed.disconnectTimer);
    }

    handleRoomDisbandTimer(roomCode);
}

function bindUserToRoom(socket, roomCode, userData, { createIfMissing = false } = {}) {
    if (!userData || !userData.user || !userData.sessionId) {
        return { ok: false, error: "缺少登录信息，请刷新后重新进入" };
    }

    const clientIp = socket.handshake.address || socket.request.connection.remoteAddress || "";
    const ipBlacklist = getBlacklistedIps();

    // 检查黑名单 IP
    if (ipBlacklist.some(ip => clientIp.includes(ip))) {
        console.log(`[拦截] IP 被封禁的用户尝试加入房间: ${clientIp}`);
        return { ok: false, error: "您的 IP 存在违规行为，无法进入聊天室" };
    }

    let room = rooms.get(roomCode);
    if (!room) {
        if (!createIfMissing) {
            return { ok: false, error: "房间不存在，请确认房间密码" };
        }
        room = { users: [], messages: [] };
        rooms.set(roomCode, room);
    }

    const existingUser = room.users.find((user) => user.sessionId === userData.sessionId);
    if (room.users.length >= 2 && !existingUser) {
        return { ok: false, error: "房间已满，仅允许两人聊天" };
    }

    if (existingUser) {
        if (existingUser.disconnectTimer) {
            clearTimeout(existingUser.disconnectTimer);
            existingUser.disconnectTimer = null;
        }
        existingUser.id = socket.id;
        existingUser.user = userData.user;
        existingUser.avatar = userData.avatar;
        existingUser.online = true;
    } else {
        room.users.push({
            sessionId: userData.sessionId,
            id: socket.id,
            user: userData.user,
            avatar: userData.avatar,
            online: true,
            disconnectTimer: null,
        });
    }

    socket.join(roomCode);
    socket.userData = { ...userData, roomCode };
    socket.roomCode = roomCode;

    handleRoomDisbandTimer(roomCode);

    return { ok: true, roomCode, users: getPublicUsers(room) };
}

io.on("connection",(socket)=>{

    socket.on("create-room",(userData)=>{
        const roomCode = createRoomCode();
        const result = bindUserToRoom(socket, roomCode, userData, { createIfMissing: true });
        if (!result.ok) {
            socket.emit("room-error", result.error);
            return;
        }

        socket.emit("room-created", { roomCode: result.roomCode });
        emitRoomState(result.roomCode);
        const clientIp = socket.handshake.address || socket.request.connection.remoteAddress || "";
        console.log(`[${result.roomCode}] ${userData.user} 创建房间 (${clientIp})`);
        recordChatEvent(result.roomCode, userData.user, "创建房间", clientIp);
    });

    socket.on("join-room",(payload)=>{
        const result = bindUserToRoom(socket, payload?.roomCode, payload, { createIfMissing: false });
        if (!result.ok) {
            socket.emit("room-error", result.error);
            return;
        }

        emitRoomState(result.roomCode);
        const clientIp = socket.handshake.address || socket.request.connection.remoteAddress || "";
        console.log(`[${result.roomCode}] ${payload.user} 加入房间 (${clientIp})`);
        recordChatEvent(result.roomCode, payload.user, "加入房间", clientIp);
    });

    socket.on("leave-room", (payload = {}) => {
        const roomCode = payload.roomCode || socket.roomCode || socket.userData?.roomCode;
        const sessionId = payload.sessionId || socket.userData?.sessionId;
        if (!roomCode || !sessionId) return;

        const userName = socket.userData ? socket.userData.user : sessionId;
        removeUser(roomCode, sessionId);
        emitRoomState(roomCode);
        console.log(`[${roomCode}] ${userName} 主动退出`);
        recordChatEvent(roomCode, userName, "主动退出");
    });

    socket.on("chat message",(msgObj)=>{
        const roomCode = socket.roomCode || socket.userData?.roomCode || msgObj.roomCode;
        if (!roomCode) return;

        const room = rooms.get(roomCode);
        if (!room) return;

        const roomMessage = {
            id: msgObj.id || `${Date.now()}-${crypto.randomUUID()}`,
            user: socket.userData?.user || msgObj.user,
            avatar: socket.userData?.avatar || msgObj.avatar,
            message: msgObj.message,
            time: msgObj.time || "",
            sessionId: socket.userData?.sessionId || msgObj.sessionId,
            createdAt: msgObj.createdAt || Date.now(),
        };

        room.messages.push(roomMessage);
        recordChatMessage(roomCode, roomMessage.user, roomMessage.message);

        room.users.forEach((user) => {
            if (user.id !== socket.id && user.online) {
                io.to(user.id).emit("chat message", roomMessage);
            }
        });
    });

    socket.on("recall message", (payload = {}, callback) => {
        const roomCode = socket.roomCode || socket.userData?.roomCode || payload.roomCode;
        const messageId = payload.messageId;
        const sessionId = socket.userData?.sessionId;

        if (!roomCode || !messageId || !sessionId) {
            if (typeof callback === "function") {
                callback({ ok: false, reason: "撤回失败" });
            }
            return;
        }

        const room = rooms.get(roomCode);
        if (!room) {
            if (typeof callback === "function") {
                callback({ ok: false, reason: "房间不存在" });
            }
            return;
        }

        const index = room.messages.findIndex((message) => message.id === messageId);
        if (index === -1) {
            if (typeof callback === "function") {
                callback({ ok: false, reason: "消息不存在或已被撤回" });
            }
            return;
        }

        const targetMessage = room.messages[index];
        if (targetMessage.sessionId !== sessionId) {
            if (typeof callback === "function") {
                callback({ ok: false, reason: "只能撤回自己的消息" });
            }
            return;
        }
        if (Date.now() - Number(targetMessage.createdAt || 0) > RECALL_WINDOW_MS) {
            if (typeof callback === "function") {
                callback({ ok: false, reason: "超过2分钟，无法撤回" });
            }
            return;
        }

        const recalledContent = targetMessage.message;
        targetMessage.recalled = true;
        targetMessage.recalledAt = Date.now();
        targetMessage.recalledBySessionId = sessionId;
        targetMessage.message = "";
        recordChatMessage(roomCode, targetMessage.user, recalledContent, { recalled: true });
        emitRoomState(roomCode);
        if (typeof callback === "function") {
            callback({ ok: true, messages: getPublicMessages(room) });
        }
        console.log("消息撤回:", roomCode, messageId);
    });

    socket.on("disconnect",()=>{
        const roomCode = socket.roomCode || socket.userData?.roomCode;
        if (!roomCode) return;

        const room = rooms.get(roomCode);
        if (!room) return;

        const disconnectedUser = room.users.find((user) => user.id === socket.id);
        if (!disconnectedUser) return;

        disconnectedUser.id = null;
        disconnectedUser.online = false;
        disconnectedUser.disconnectTimer = setTimeout(() => {
            const sessionId = disconnectedUser.sessionId;
            const userName = disconnectedUser.user;
            removeUser(roomCode, sessionId);
            emitRoomState(roomCode);
            console.log(`[${roomCode}] ${userName} 超时退出`);
            recordChatEvent(roomCode, userName, "超时退出");
        }, AUTO_LOGOUT_MS);

        emitRoomState(roomCode);
        const userName = socket.userData ? socket.userData.user : socket.id;
        console.log(`[${roomCode}] ${userName} 断开连接`);
        recordChatEvent(roomCode, userName, "断开连接");
    });
});

// server.js
server.listen(3000, "0.0.0.0", () => {
    const localUrls = getLocalIPv4Addresses().map((address) => `http://${address}:3000`);
    console.log("Server running on http://localhost:3000");
    if (localUrls.length > 0) {
        console.log("手机或其他设备请访问以下局域网地址:");
        localUrls.forEach((url) => console.log(url));
    } else {
        console.log("未检测到局域网 IPv4 地址，手机需要和电脑在同一网络下才能访问。\n");
    }
});