const { WebSocket } = require('ws');

class ClientManager {
  constructor() {
    this.clients = new Map();
  }

  add(socket, request, id) {
    const client = {
      id,
      socket,
      isAlive: true,
      isListening: false,
      droppedPackets: 0,
      remoteAddress: formatRemoteAddress(request.socket.remoteAddress),
      connectedAt: Date.now(),
      pcmChunksSent: 0,
    };

    this.clients.set(id, client);
    console.log(
      `WebSocket client connected id=${id} ip=${client.remoteAddress || 'unknown'}`,
    );
    return client;
  }

  remove(id) {
    const client = this.clients.get(id);
    if (!client) {
      return;
    }

    this.clients.delete(id);
    console.log(
      `WebSocket client disconnected id=${id} ip=${client.remoteAddress || 'unknown'}`,
    );
  }

  get size() {
    return this.clients.size;
  }

  values() {
    return this.clients.values();
  }

  listeningClients() {
    return [...this.clients.values()].filter((client) => client.isListening);
  }

  send(client, payload) {
    if (client.socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    client.socket.send(JSON.stringify({ ...payload, serverTime: Date.now() }));
    return true;
  }

  broadcast(payload) {
    for (const client of this.clients.values()) {
      this.send(client, payload);
    }
  }

  connectionStatus() {
    return {
      type: 'connection.status',
      status: 'connected',
      listeners: this.clients.size,
    };
  }
}

function formatRemoteAddress(remoteAddress) {
  if (!remoteAddress) {
    return 'unknown';
  }

  return remoteAddress.replace(/^::ffff:/, '');
}

module.exports = { ClientManager };
