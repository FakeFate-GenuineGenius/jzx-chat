const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const AUTO_LOGOUT_MS = 30 * 60 * 1000;

app.use(express.static("public"));

const rooms = new Map(); // roomCode -> { users: [] }

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

function emitRoomState(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;
    io.to(roomCode).emit("room-state", {
        roomCode,
        users: getPublicUsers(room),
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
        room = { users: [] };
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

        room.users.forEach((user) => {
            if (user.id !== socket.id && user.online) {
                io.to(user.id).emit("chat message", msgObj);
            }
        });
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