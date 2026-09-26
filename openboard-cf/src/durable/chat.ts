/**
 * ChatHub —— Durable Object，替代原项目内存里的 ConnectionManager
 *
 * 为什么必须是 DO：
 *   原 FastAPI 版把连接存在进程内存（active_connections 字典），
 *   一旦部署到 Cloudflare，每个请求可能落在不同的边缘节点，内存态广播直接失效。
 *   DO 提供全局单实例 + 持久化，是所有节点共享的广播中枢。
 *
 * 采用 WebSocket Hibernation：
 *   连接空闲时 DO 可被逐出内存而不掉线，空闲期间不计 CPU / 内存费用，
 *   对聊天这种长连接低流量场景能省下大量开销。
 */
import type { Env } from '../env';

interface Attachment {
  username: string;
  connectedAt: number;
}

interface BroadcastBody {
  message: unknown;
  /** 私聊接收者；有值则只发给 sender + receiver */
  receiver?: string | null;
  /** 群/房间 ID；仅用于日志与未来分片 */
  room_id?: number | null;
  sender?: string | null;
  /** 指定接收者列表（群成员定向推送，可选） */
  only?: string[] | null;
}

export class ChatHub implements DurableObject {
  private env: Env;
  /** 在线用户名集合（内存态，仅用于 online_status 广播） */
  private online = new Set<string>();

  constructor(readonly ctx: DurableObjectState, env: Env) {
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // --- WebSocket 建立 -----------------------------------------------------
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const username = url.searchParams.get('username');
      if (!username) return new Response('missing username', { status: 400 });

      const pair = new WebSocketPair();
      const server = pair[1];
      this.ctx.acceptWebSocket(server, [username]);
      this.online.add(username);

      server.serializeAttachment({ username, connectedAt: Date.now() } satisfies Attachment);

      this.evictOverflow(username);
      await this.pushOnlineStatus();

      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // --- 内部广播入口（由 Worker 调用）--------------------------------------
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const body = (await request.json()) as BroadcastBody;
      await this.broadcast(body);
      return new Response('ok');
    }

    // --- 强制下线某用户所有连接 ---------------------------------------------
    if (url.pathname === '/kick' && request.method === 'POST') {
      const { username } = (await request.json()) as { username: string };
      for (const ws of this.ctx.getWebSockets(username)) {
        try {
          ws.close(4001, 'kicked');
        } catch {
          /* 已断开 */
        }
      }
      this.online.delete(username);
      await this.pushOnlineStatus();
      return new Response('ok');
    }

    // --- 在线状态查询 --------------------------------------------------------
    if (url.pathname === '/online') {
      return Response.json({ users: [...this.online] });
    }

    return new Response('not found', { status: 404 });
  }

  /** 超过每用户连接上限时，踢掉最旧的一条 */
  private evictOverflow(username: string) {
    const limit = parseInt(this.env.MAX_CONNECTIONS_PER_USER || '4', 10) || 4;
    const sockets = this.ctx.getWebSockets(username);
    if (sockets.length <= limit) return;

    const meta = sockets.map((ws) => {
      const att = ws.deserializeAttachment() as Attachment | null;
      return { ws, at: att?.connectedAt ?? 0 };
    });
    meta.sort((a, b) => a.at - b.at);

    for (const { ws } of meta.slice(0, sockets.length - limit)) {
      try {
        ws.close(1013, 'connection limit reached');
      } catch {
        /* 已断开 */
      }
    }
  }

  private async pushOnlineStatus() {
    await this.broadcast({ message: { type: 'online_status', users: [...this.online] } });
  }

  async broadcast(body: BroadcastBody) {
    const payload = JSON.stringify(body.message);
    const { receiver, sender, only } = body;

    let targets: WebSocket[];
    if (only && only.length) {
      const set = new Set(only);
      targets = this.ctx.getWebSockets().filter((ws) => {
        const att = ws.deserializeAttachment() as Attachment | null;
        return !!att && set.has(att.username);
      });
    } else if (receiver) {
      const names = sender ? [sender, receiver] : [receiver];
      targets = names.flatMap((n) => this.ctx.getWebSockets(n));
    } else {
      targets = this.ctx.getWebSockets();
    }

    const dead: WebSocket[] = [];
    for (const ws of targets) {
      try {
        ws.send(payload);
      } catch {
        dead.push(ws);
      }
    }
    for (const ws of dead) {
      try {
        ws.close(1011, 'send failed');
      } catch {
        /* noop */
      }
    }
  }

  // --- WebSocket Hibernation 回调 -------------------------------------------
  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    if (typeof message !== 'string') return;
    let data: { type?: string; room_id?: number; receiver?: string };
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    const att = ws.deserializeAttachment() as Attachment | null;
    const username = att?.username;
    if (!username) return;

    if (data.type === 'typing') {
      await this.broadcast({
        message: {
          type: 'typing',
          user: username,
          room_id: data.room_id ?? null,
          receiver: data.receiver ?? null,
        },
        receiver: data.receiver ?? null,
        sender: username,
      });
    } else if (data.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  }

  async webSocketClose(ws: WebSocket) {
    const att = ws.deserializeAttachment() as Attachment | null;
    const username = att?.username;
    if (!username) return;

    const stillAlive = this.ctx.getWebSockets(username).length;
    if (stillAlive === 0) this.online.delete(username);
    await this.pushOnlineStatus();
  }

  async webSocketError(ws: WebSocket) {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.username) {
      const stillAlive = this.ctx.getWebSockets(att.username).length;
      if (stillAlive === 0) this.online.delete(att.username);
    }
    try {
      ws.close(1011, 'ws error');
    } catch {
      /* noop */
    }
  }
}
