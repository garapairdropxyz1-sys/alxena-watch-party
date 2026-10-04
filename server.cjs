const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const rooms = new Map();
const streams = new Map();

function id(prefix = "") {
  return prefix + crypto.randomBytes(6).toString("hex");
}

function defaultRoom(roomId, data = {}) {
  return {
    id: roomId,
    name: data.name || `Lounge Alxena ${roomId}`,
    description: data.description || "Ruang santai Alxena 🌸",
    hostId: data.hostId || null,
    coHosts: [],
    settings: {
      maxUsers: 50,
      isPublic: true,
      password: "",
      emoji: "🌸",
      color: "from-pink-400 to-rose-300",
      background: "pink-gradient",
      allowChat: true,
      allowVoice: true,
      allowCamera: true,
      allowScreenShare: true,
      allowPlaylist: true,
      allowSkip: true,
      allowUpload: true,
      ...(data.settings || {})
    },
    users: [],
    playlist: data.playlist || [],
    currentVideoId: data.currentVideoId || null,
    playbackState: {
      isPlaying: false,
      currentTime: 0,
      speed: 1,
      lastUpdated: Date.now()
    },
    chats: [],
    polls: []
  };
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, defaultRoom(roomId));
  }
  return rooms.get(roomId);
}

function send(roomId, event) {
  const clients = streams.get(roomId);
  if (!clients) return;

  const data = `data: ${JSON.stringify(event)}\n\n`;

  for (const res of clients) {
    res.write(data);
  }
}

function publicRoom(room) {
  return {
    ...room,
    chats: room.chats || []
  };
}

/* =========================
   AUTH
========================= */

const users = new Map();

app.post("/api/auth/register", (req, res) => {
  const { username, email, password, avatar } = req.body || {};

  if (!username || !email || !password) {
    return res.status(400).json({
      ok: false,
      error: "Username, email, dan password wajib diisi."
    });
  }

  if (users.has(email)) {
    return res.status(409).json({
      ok: false,
      error: "Email sudah terdaftar."
    });
  }

  const user = {
    id: id("user-"),
    username,
    email,
    avatar: avatar || "🐰",
    status: "Online",
    bio: "",
    level: 1,
    xp: 0,
    achievements: [],
    badges: [],
    theme: "pink",
    language: "Indonesia"
  };

  users.set(email, {
    ...user,
    password
  });

  res.json({
    ok: true,
    token: id("token-"),
    user
  });
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  const user = users.get(email);

  if (!user || user.password !== password) {
    return res.status(401).json({
      ok: false,
      error: "Email atau password salah."
    });
  }

  const { password: _, ...safeUser } = user;

  res.json({
    ok: true,
    token: id("token-"),
    user: safeUser
  });
});

/* =========================
   ROOMS
========================= */

app.get("/api/rooms/:roomId", (req, res) => {
  res.json(publicRoom(getRoom(req.params.roomId)));
});

app.post("/api/rooms", (req, res) => {
  const body = req.body || {};

  const roomId =
    body.id ||
    crypto.randomBytes(4).toString("hex");

  const room = defaultRoom(roomId, body);

  rooms.set(roomId, room);

  res.json({
    ok: true,
    id: roomId,
    room
  });
});

/* =========================
   REALTIME SSE
========================= */

app.get("/api/rooms/:roomId/sync", (req, res) => {
  const roomId = req.params.roomId;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  if (!streams.has(roomId)) {
    streams.set(roomId, new Set());
  }

  streams.get(roomId).add(res);

  const room = getRoom(roomId);

  res.write(
    `data: ${JSON.stringify({
      type: "init_state",
      payload: {
        room: publicRoom(room),
        chat: room.chats || []
      }
    })}\n\n`
  );

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    streams.get(roomId)?.delete(res);
  });
});

/* =========================
   ROOM ACTIONS
========================= */

app.post("/api/rooms/:roomId/action", (req, res) => {
  const room = getRoom(req.params.roomId);
  const { action, senderId, senderName, payload = {} } = req.body || {};

  switch (action) {
    case "user_state": {
      const user = payload.user;

      if (user && !room.users.some(u => u.id === user.id)) {
        room.users.push(user);
      }

      send(req.params.roomId, {
        type: "user_state",
        payload: {
          user,
          users: room.users
        }
      });

      break;
    }

    case "user_leave": {
      room.users = room.users.filter(
        u => u.id !== payload.userId
      );

      send(req.params.roomId, {
        type: "user_leave",
        payload: {
          userId: payload.userId,
          users: room.users
        }
      });

      break;
    }

    case "video_sync": {
      room.playbackState = {
        ...room.playbackState,
        isPlaying: !!payload.isPlaying,
        currentTime: Number(payload.currentTime || 0),
        speed: Number(payload.speed || 1),
        lastUpdated: Date.now()
      };

      send(req.params.roomId, {
        type: "video_sync",
        payload: room.playbackState
      });

      break;
    }

    case "playlist_update": {
      room.playlist = payload.playlist || [];
      room.currentVideoId =
        payload.currentVideoId ?? room.currentVideoId;

      send(req.params.roomId, {
        type: "playlist_update",
        payload: {
          playlist: room.playlist,
          currentVideoId: room.currentVideoId
        }
      });

      break;
    }

    default:
      send(req.params.roomId, {
        type: action || "room_update",
        payload
      });
  }

  res.json({
    ok: true,
    room: publicRoom(room)
  });
});

/* =========================
   CHAT
========================= */

app.post("/api/rooms/:roomId/chat", (req, res) => {
  const room = getRoom(req.params.roomId);

  const message = {
    id: id("msg-"),
    roomId: req.params.roomId,
    senderId: req.body.senderId,
    senderName: req.body.senderName,
    senderAvatar: req.body.senderAvatar,
    text: req.body.text || "",
    timestamp: Date.now(),
    replyTo: req.body.replyTo || null,
    attachments: req.body.attachments || [],
    reactions: [],
    isPinned: false
  };

  room.chats.push(message);

  send(req.params.roomId, {
    type: "chat_message",
    payload: message
  });

  res.json({
    ok: true,
    message
  });
});

app.post("/api/rooms/:roomId/chat/modify", (req, res) => {
  const room = getRoom(req.params.roomId);

  const {
    messageId,
    action,
    payload = {}
  } = req.body || {};

  const index = room.chats.findIndex(
    m => m.id === messageId
  );

  if (index === -1) {
    return res.status(404).json({
      ok: false,
      error: "Message not found."
    });
  }

  const message = room.chats[index];

  if (action === "edit") {
    message.text = payload.text || message.text;
    message.editedAt = Date.now();
  }

  if (action === "delete") {
    room.chats.splice(index, 1);
  }

  if (action === "pin") {
    message.isPinned = !!payload.isPinned;
  }

  if (action === "reaction") {
    const reactions = message.reactions || [];
    const existing = reactions.findIndex(
      r =>
        r.userId === payload.userId &&
        r.emoji === payload.emoji
    );

    if (existing >= 0) {
      reactions.splice(existing, 1);
    } else {
      reactions.push({
        userId: payload.userId,
        username: payload.username,
        emoji: payload.emoji
      });
    }

    message.reactions = reactions;
  }

  send(req.params.roomId, {
    type:
      action === "edit"
        ? "chat_edit"
        : action === "delete"
        ? "chat_delete"
        : action === "pin"
        ? "chat_pin"
        : "chat_reaction",
    payload:
      action === "delete"
        ? { messageId }
        : message
  });

  res.json({
    ok: true
  });
});

/* =========================
   VOICE
========================= */

app.post("/api/rooms/:roomId/voice", (req, res) => {
  send(req.params.roomId, {
    type: "voice_update",
    payload: req.body || {}
  });

  res.json({
    ok: true
  });
});

/* =========================
   AI PLACEHOLDERS
========================= */

app.post("/api/rooms/:roomId/ai/summarize", (req, res) => {
  res.json({
    ok: true,
    summary: "Ringkasan AI belum dikonfigurasi."
  });
});

app.post("/api/rooms/any/ai/subtitle", (req, res) => {
  res.json({
    ok: true,
    subtitles: []
  });
});

/* ========================= */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "Alxena Watch Party API",
    rooms: rooms.size
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌸 AWP API running on http://0.0.0.0:${PORT}`);
});
