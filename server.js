const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const AUTO_LOGOUT_MS = 30 * 60 * 1000;
const RECALL_WINDOW_MS = 2 * 60 * 1000;
const LOGS_DIR = path.join(__dirname, "logs");

fs.mkdirSync(LOGS_DIR, { recursive: true });

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

function appendChatLogLine(line) {
    try {
        fs.appendFileSync(getChatLogFilePath(), `${line}\n`, "utf8");
    } catch (error) {
        console.error("写入聊天记录失败:", error);
    }
}

function recordChatMessage(roomCode, speakerName, content, { recalled = false } = {}) {
    const statusText = recalled ? " | 状态:已撤回" : "";
    appendChatLogLine(`[${formatLogTime()}] | 房间号:${roomCode} | 说话人:${speakerName}${statusText} | 内容:${content}`);
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

function deleteRoomIfEmpty(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || room.users.length > 0) return;
    rooms.delete(roomCode);
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

    deleteRoomIfEmpty(roomCode);
}

function bindUserToRoom(socket, roomCode, userData, { createIfMissing = false } = {}) {
    if (!userData || !userData.user || !userData.sessionId) {
        return { ok: false, error: "缺少登录信息，请刷新后重新进入" };
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
        console.log("房间创建:", result.roomCode, userData.user);
    });

    socket.on("join-room",(payload)=>{
        const result = bindUserToRoom(socket, payload?.roomCode, payload, { createIfMissing: false });
        if (!result.ok) {
            socket.emit("room-error", result.error);
            return;
        }

        emitRoomState(result.roomCode);
        console.log("用户加入:", result.roomCode, payload.user);
    });

    socket.on("leave-room", (payload = {}) => {
        const roomCode = payload.roomCode || socket.roomCode || socket.userData?.roomCode;
        const sessionId = payload.sessionId || socket.userData?.sessionId;
        if (!roomCode || !sessionId) return;

        removeUser(roomCode, sessionId);
        emitRoomState(roomCode);
        console.log("用户主动退出:", roomCode, socket.userData ? socket.userData.user : sessionId);
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
            console.log("用户超时退出:", roomCode, userName);
        }, AUTO_LOGOUT_MS);

        emitRoomState(roomCode);
        console.log("用户离开:", roomCode, socket.userData ? socket.userData.user : socket.id);
    });
});

// server.js
server.listen(3000, "0.0.0.0", () => {
    console.log("Server running on http://192.168.11.84:3000");
});