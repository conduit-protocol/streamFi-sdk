const { RoomManager } = require('./room-manager');
require('dotenv').config();

const MAX_ROOM_SIZE = process.env.MAX_ROOM_SIZE ? parseInt(process.env.MAX_ROOM_SIZE, 10) : Infinity;

const roomManager = new RoomManager({ maxRoomSize: MAX_ROOM_SIZE });

function handleJoin(clientId, roomId, ws) {
  const result = roomManager.join(clientId, roomId, ws);
  if (!result.ok && result.reason === 'ROOM_FULL') {
    ws.send(JSON.stringify({
      type: "error",
      payload: {
        message: "Room is full",
        code: "ROOM_FULL"
      }
    }));
  }
  return result;
}

module.exports = { handleJoin, roomManager };
