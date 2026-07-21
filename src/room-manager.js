class RoomManager {
  constructor(options = {}) {
    this._maxRoomSize = options.maxRoomSize !== undefined ? options.maxRoomSize : Infinity;
    this._rooms = new Map(); // roomId -> Map(clientId -> ws)
    this._clientRooms = new Map(); // clientId -> Set(roomId)
  }

  _ensureRoom(roomId) {
    if (!this._rooms.has(roomId)) {
      this._rooms.set(roomId, new Map());
    }
    return this._rooms.get(roomId);
  }

  _ensureClientRooms(clientId) {
    if (!this._clientRooms.has(clientId)) {
      this._clientRooms.set(clientId, new Set());
    }
    return this._clientRooms.get(clientId);
  }

  join(clientId, roomId, ws) {
    const room = this._ensureRoom(roomId);
    if (!room.has(clientId) && room.size >= this._maxRoomSize) {
      return { ok: false, reason: 'ROOM_FULL' };
    }
    room.set(clientId, ws);
    this._ensureClientRooms(clientId).add(roomId);
    return { ok: true };
  }

  leave(clientId, roomId) {
    const room = this._rooms.get(roomId);
    if (room) {
      room.delete(clientId);
      if (room.size === 0) {
        this._rooms.delete(roomId);
      }
    }
    const clientRooms = this._clientRooms.get(clientId);
    if (clientRooms) {
      clientRooms.delete(roomId);
      if (clientRooms.size === 0) {
        this._clientRooms.delete(clientId);
      }
    }
  }
}

module.exports = { RoomManager };
