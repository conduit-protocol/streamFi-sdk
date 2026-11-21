const fs = require('fs');
let code = fs.readFileSync('src/relayer/WebSocketRelayer.ts', 'utf8');

code = code.replace(
  'async send(message: WebSocketMessage): Promise<void> {',
  `private _queueMessage(message: WebSocketMessage): void {
    if (this.pendingMessages.length >= this.maxPendingMessages) {
      this.pendingMessages.shift();
    }
    this.pendingMessages.push(message);
  }

  async send(message: WebSocketMessage): Promise<void> {`
);

code = code.replace(/this\.pendingMessages\.push\(message\);/g, 'this._queueMessage(message);');

fs.writeFileSync('src/relayer/WebSocketRelayer.ts', code);
