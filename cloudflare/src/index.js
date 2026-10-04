function makeId(prefix = "") {
  return prefix + crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

function defaultRoom(roomId, data = {}) {
  return {
    id: roomId,
    name: data.name || `Lounge Alxena ${roomId}`,
    description: data.description || "Ruang santai Alxena 🌸",
    hostId: data.hostId || data.ownerId || null,
    ownerId: data.ownerId || data.hostId || null,
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

async function json(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function response(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*"
    }
  });
}

function publicRoom(room) {
  return {
    ...room,
    chats: room.chats || []
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    if (url.pathname === "/api/health") {
      return response({
        ok: true,
        service: "Alxena Watch Party API",
        runtime: "Cloudflare Workers"
      });
    }

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    const id = env.AWP_STATE.idFromName("global");
    const stub = env.AWP_STATE.get(id);

    return stub.fetch(request);
  }
};

export class AWPState {
  constructor(state) {
    this.state = state;
    this.sessions = new Map();
  }

  async load() {
    return (
      (await this.state.storage.get("data")) || {
        users: {},
        rooms: {}
      }
    );
  }

  async save(data) {
    await this.state.storage.put("data", data);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const data = await this.load();

    if (method === "POST" && path === "/api/auth/register") {
      const body = await json(request);
      const { username, email, password, avatar } = body;

      if (!username || !email || !password) {
        return response({
          ok: false,
          error: "Username, email, dan password wajib diisi."
        }, 400);
      }

      if (data.users[email]) {
        return response({
          ok: false,
          error: "Email sudah terdaftar."
        }, 409);
      }

      const user = {
        id: makeId("user-"),
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

      data.users[email] = {
        ...user,
        password
      };

      await this.save(data);

      return response({
        ok: true,
        token: makeId("token-"),
        user
      });
    }

    if (method === "POST" && path === "/api/auth/login") {
      const body = await json(request);
      const { email, password } = body;

      const user = data.users[email];

      if (!user || user.password !== password) {
        return response({
          ok: false,
          error: "Email atau password salah."
        }, 401);
      }

      const { password: _, ...safeUser } = user;

      return response({
        ok: true,
        token: makeId("token-"),
        user: safeUser
      });
    }

    if (method === "GET" && path === "/api/auth/profile") {
      const email = new URL(request.url).searchParams.get("email");
      const user = email ? data.users[email] : null;

      if (!user) {
        return response({ ok: false, error: "User not found" }, 404);
      }

      const { password, ...safeUser } = user;
      return response({ ok: true, user: safeUser });
    }

    if (method === "PUT" && path === "/api/auth/profile") {
      const body = await json(request);
      const email = body.email;
      const user = data.users[email];

      if (!user) return response({ ok: false, error: "User not found" }, 404);

      if (body.username) user.username = String(body.username).trim();
      if (body.avatar !== undefined) user.avatar = body.avatar;
      if (body.bio !== undefined) user.bio = body.bio;
      if (body.status !== undefined) user.status = body.status;

      data.users[email] = user;
      await this.save(data);

      const { password, ...safeUser } = user;
      return response({ ok: true, user: safeUser });
    }

    // Room collection endpoints
    if (path === "/api/rooms") {
      if (method === "GET") {
        await this.save(data);
        return response(
          Object.values(data.rooms || {}).map(room => publicRoom(room))
        );
      }

      if (method === "POST") {
        const body = await json(request);

        const newRoomId =
          body.id ||
          crypto.randomUUID().replaceAll("-", "").slice(0, 8);

        const roomData = {
          ...body,
          ownerId: body.ownerId || body.hostId || null,
          hostId: body.hostId || body.ownerId || null
        };

        data.rooms[newRoomId] = defaultRoom(newRoomId, roomData);

        // Creator langsung menjadi member/host
        if (body.hostId) {
          data.rooms[newRoomId].users = [{
            id: body.hostId,
            username: body.hostName || "Host",
            avatar: body.hostAvatar || "🐰",
            status: "Online"
          }];
        }

        await this.save(data);

        return response({
          ok: true,
          id: newRoomId,
          room: data.rooms[newRoomId]
        });
      }
    }

    const roomMatch = path.match(/^\/api\/rooms\/([^/]+)(?:\/(.*))?$/);

    if (roomMatch) {
      const roomId = roomMatch[1];
      const subpath = roomMatch[2] || "";

      if (!data.rooms[roomId]) {
        data.rooms[roomId] = defaultRoom(roomId);
      }

      const room = data.rooms[roomId];

      if (method === "GET" && subpath === "") {
        await this.save(data);

        return response(publicRoom(room));
      }

      if (method === "POST" && subpath === "") {
        const body = await json(request);

        const newRoomId =
          body.id ||
          crypto.randomUUID().replaceAll("-", "").slice(0, 8);

        body.ownerId = body.ownerId || body.hostId || null;
        body.hostId = body.hostId || body.ownerId || null;
        data.rooms[newRoomId] = defaultRoom(newRoomId, body);

        await this.save(data);

        return response({
          ok: true,
          id: newRoomId,
          room: data.rooms[newRoomId]
        });
      }

      if (method === "GET" && subpath === "sync") {
        const encoder = new TextEncoder();

        let controllerRef;

        const stream = new ReadableStream({
          start: controller => {
            controllerRef = controller;

            const initial = {
              type: "init_state",
              payload: {
                room: publicRoom(room),
                chat: room.chats || []
              }
            };

            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(initial)}\n\n`)
            );
          },

          cancel() {
            controllerRef = null;
          }
        });

        const sessionKey = crypto.randomUUID();

        this.sessions.set(sessionKey, {
          roomId,
          controller: controllerRef,
          encoder
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }

      if (method === "POST" && subpath === "action") {
        const body = await json(request);
        const {
          action,
          senderId,
          senderName,
          payload = {}
        } = body;

        switch (action) {
          case "user_state": {
            const user = payload.user;

            if (
              user &&
              !room.users.some(existing => existing.id === user.id)
            ) {
              room.users.push(user);
            }

            await this.broadcast(roomId, {
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
              user => user.id !== payload.userId
            );

            await this.broadcast(roomId, {
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

            await this.broadcast(roomId, {
              type: "video_sync",
              payload: room.playbackState
            });

            break;
          }

          case "playlist_update": {
            room.playlist = payload.playlist || [];

            room.currentVideoId =
              payload.currentVideoId ?? room.currentVideoId;

            await this.broadcast(roomId, {
              type: "playlist_update",
              payload: {
                playlist: room.playlist,
                currentVideoId: room.currentVideoId
              }
            });

            break;
          }

          default:
            await this.broadcast(roomId, {
              type: action || "room_update",
              payload
            });
        }

        await this.save(data);

        return response({
          ok: true,
          room: publicRoom(room)
        });
      }

      if (method === "POST" && subpath === "chat") {
        const body = await json(request);

        const message = {
          id: makeId("msg-"),
          roomId,
          senderId: body.senderId,
          senderName: body.senderName,
          senderAvatar: body.senderAvatar,
          text: body.text || "",
          timestamp: Date.now(),
          replyTo: body.replyTo || null,
          attachments: body.attachments || [],
          reactions: [],
          isPinned: false
        };

        room.chats.push(message);

        await this.broadcast(roomId, {
          type: "chat_message",
          payload: message
        });

        await this.save(data);

        return response({
          ok: true,
          message
        });
      }

      if (method === "POST" && subpath === "chat/modify") {
        const body = await json(request);

        const {
          messageId,
          action,
          payload = {}
        } = body;

        const index = room.chats.findIndex(
          message => message.id === messageId
        );

        if (index === -1) {
          return response({
            ok: false,
            error: "Message not found."
          }, 404);
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
            reaction =>
              reaction.userId === payload.userId &&
              reaction.emoji === payload.emoji
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

        await this.broadcast(roomId, {
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

        await this.save(data);

        return response({ ok: true });
      }

      if (method === "POST" && subpath === "voice") {
        const body = await json(request);

        await this.broadcast(roomId, {
          type: "voice_update",
          payload: body
        });

        return response({ ok: true });
      }

      if (method === "POST" && subpath === "ai/summarize") {
        return response({
          ok: true,
          summary: "Ringkasan AI belum dikonfigurasi."
        });
      }
    }

    if (
      method === "POST" &&
      path === "/api/rooms/any/ai/subtitle"
    ) {
      return response({
        ok: true,
        subtitles: []
      });
    }

    return response({
      ok: false,
      error: "Endpoint not found."
    }, 404);
  }

  async broadcast(roomId, event) {
    const data = JSON.stringify(event);
    const encoded = `data: ${data}\n\n`;

    for (const [key, session] of this.sessions) {
      if (session.roomId !== roomId) continue;

      try {
        if (session.controller) {
          session.controller.enqueue(
            session.encoder.encode(encoded)
          );
        }
      } catch {
        this.sessions.delete(key);
      }
    }
  }
}
