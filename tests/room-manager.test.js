const { expect, test, describe } = require('vitest');
const { RoomManager } = require('../src/room-manager');
const { handleJoin, roomManager } = require('../src/server');

describe('RoomManager', () => {
  test('join under capacity returns ok: true', () => {
    const manager = new RoomManager({ maxRoomSize: 2 });
    const ws1 = { send: () => {} };
    const ws2 = { send: () => {} };

    expect(manager.join('client1', 'room1', ws1)).toEqual({ ok: true });
    expect(manager.join('client2', 'room1', ws2)).toEqual({ ok: true });
  });

  test('join at capacity returns ok: false, reason: ROOM_FULL', () => {
    const manager = new RoomManager({ maxRoomSize: 2 });
    const ws1 = { send: () => {} };
    const ws2 = { send: () => {} };
    const ws3 = { send: () => {} };

    manager.join('client1', 'room1', ws1);
    manager.join('client2', 'room1', ws2);
    
    expect(manager.join('client3', 'room1', ws3)).toEqual({ ok: false, reason: 'ROOM_FULL' });
  });

  test('server.js sends error frame when join is rejected', () => {
    // Reset roomManager to ensure clean state for this test if needed
    roomManager._maxRoomSize = 1;
    roomManager._rooms.clear();
    roomManager._clientRooms.clear();

    const ws1 = { send: () => {} };
    let sentMessage = null;
    const ws2 = { 
      send: (msg) => { sentMessage = msg; } 
    };

    handleJoin('client1', 'room2', ws1);
    const result = handleJoin('client2', 'room2', ws2);

    expect(result).toEqual({ ok: false, reason: 'ROOM_FULL' });
    expect(sentMessage).toBe(JSON.stringify({
      type: "error",
      payload: {
        message: "Room is full",
        code: "ROOM_FULL"
      }
    }));
  });
});
