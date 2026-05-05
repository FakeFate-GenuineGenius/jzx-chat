const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

let room = []; // 保存两人 {id, user, avatar}

io.on("connection",(socket)=>{

    socket.on("join",(userData)=>{
        if(room.length>=2){
            socket.emit("full","聊天室已满，仅允许两人聊天");
            socket.disconnect();
            return;
        }
        socket.userData = userData;
        room.push({id:socket.id, user:userData.user, avatar:userData.avatar});
        io.emit("update users", room);
        console.log("用户加入:", userData.user);
    });

    socket.on("chat message",(msgObj)=>{
        room.forEach(u=>{
            if(u.id!==socket.id) io.to(u.id).emit("chat message", msgObj);
        });
    });

    socket.on("disconnect",()=>{
        room = room.filter(u=>u.id!==socket.id);
        io.emit("update users", room);
        console.log("用户离开:", socket.userData ? socket.userData.user : socket.id);
    });
});

// server.js
server.listen(3000, "0.0.0.0", () => {
    console.log("Server running on http://192.168.11.84:3000");
});