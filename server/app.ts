import express from 'express';
import { createServer } from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Server } from 'socket.io';
import { Store } from './store.js';
import { applyAction, authorize, botAction, GameError, log, makePlayer, makeRoom, requireRule, snapshot, timeoutRoom } from './engine.js';
import { commandSchema, createSchema, joinSchema, sessionSchema } from './validation.js';
import type { Action, Reply, Room, RoomSummary, Session } from '../shared/game.js';

export async function createApplication(options: { dataDir?: string; databaseUrl?: string; production?: boolean; turnMs?: number; tickMs?: number; allowedOrigins?: string[] } = {}) {
  const store = await Store.open(options), rooms = new Map((await store.loadRooms()).map(r => [r.code, r]));
  const app = express(), http = createServer(app), turnMs = options.turnMs ?? 90_000;
  const allowed = options.allowedOrigins ?? [];
  const originAllowed = (origin: string | undefined, host: string | undefined) => !origin || allowed.includes(origin) || [ `http://${host}`, `https://${host}` ].includes(origin);
  const io = new Server(http, { maxHttpBufferSize: 16_384, pingTimeout: 20_000, pingInterval: 10_000, cors: { origin: false }, allowRequest: (req, cb) => cb(null, originAllowed(req.headers.origin, req.headers.host)) });
  const locks = new Map<string, Promise<unknown>>(), online = new Map<string, Set<string>>();
  const rates = new Map<string, { count: number; reset: number }>();
  let closing = false;
  function rate(key: string, limit: number) {
    const now = Date.now(), previous = rates.get(key), bucket = previous && previous.reset > now ? previous : { count: 0, reset: now + 60_000 };
    bucket.count++; rates.set(key, bucket); if (bucket.count > limit) throw new GameError('操作过于频繁，请稍后再试。', 'RATE_LIMIT');
  }
  async function locked<T>(code: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(code) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(fn); locks.set(code, current);
    try { return await current; } finally { if (locks.get(code) === current) locks.delete(code); }
  }
  function getRoom(code: string): Room { const room = rooms.get(code); requireRule(room, '房间不存在，请检查房间码。'); return room; }
  function broadcast(code: string) {
    const room = rooms.get(code); if (!room) return;
    const connected = new Set(room.players.filter(p => online.get(`${code}:${p.id}`)?.size).map(p => p.id));
    for (const socket of io.sockets.sockets.values()) {
      const s: Session | undefined = socket.data.session;
      if (s?.room === code) socket.emit('snapshot', snapshot(room, s.playerId, connected));
    }
  }
  async function commit(previous: Room, next: Room, player: string, id: string, kind: string, payload: unknown) {
    await store.save(previous, next, player, id, kind, payload);
    rooms.set(next.code, next); broadcast(next.code);
  }
  const errorReply = (error: unknown): Reply => error instanceof GameError ? { ok: false, error: error.message, code: error.code } : { ok: false, error: '服务暂时不可用，状态未改变，请稍后重试。', code: 'SERVER_ERROR' };
  async function command(session: Session, raw: unknown): Promise<Reply> {
    const parsed = commandSchema.safeParse(raw); if (!parsed.success) return { ok: false, error: '操作格式不正确。', code: 'BAD_REQUEST' };
    return locked(session.room, async () => {
      try {
        rate(`cmd:${session.room}:${session.playerId}`, 180);
        const room = getRoom(session.room); requireRule(authorize(room, session.playerId, session.token), '身份验证失败。');
        const receipt = await store.receipt(room.code, session.playerId, parsed.data.id);
        if (receipt !== null) { broadcast(room.code); return { ok: true, revision: room.revision }; }
        const expired = timeoutRoom(room, Date.now(), turnMs);
        if (expired) {
          await commit(room, expired, 'system', randomUUID(), 'timeout', {});
          throw new GameError('回应时间已结束，已同步最新棋盘。', 'STALE_STATE');
        }
        if (room.revision !== parsed.data.revision) { broadcast(room.code); throw new GameError('状态已更新，已同步最新棋盘，请重新操作。', 'STALE_STATE'); }
        const next = applyAction(room, session.playerId, parsed.data.action as Action, { turnMs });
        await commit(room, next, session.playerId, parsed.data.id, parsed.data.action.type, parsed.data.action);
        return { ok: true, revision: next.revision };
      } catch (error) { if (!(error instanceof GameError)) console.error('Command persistence error:', error); return errorReply(error); }
    });
  }
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy','same-origin');
    if (req.path.startsWith('/api')) {
      res.setHeader('Cache-Control','no-store');
      if (!originAllowed(req.headers.origin, req.headers.host)) { res.status(403).json({ error: '来源不被允许。' }); return; }
      try { rate(`http:${req.socket.remoteAddress}`, 240); } catch { res.status(429).json({ error: '请求过于频繁。' }); return; }
    }
    next();
  });
  app.get('/api/health', (_req, res) => res.json({ ok: !closing, storage: store.mode, version: '1.0.0' }));
  app.get('/api/rooms', (_req, res) => {
    const result: RoomSummary[] = [...rooms.values()].filter(r => r.updatedAt > Date.now() - 86_400_000).sort((a,b) => b.updatedAt - a.updatedAt).slice(0,30).map(r => ({ code: r.code, status: r.status, players: r.players.length, host: r.players[0].name, updatedAt: r.updatedAt }));
    res.json(result);
  });
  app.post('/api/rooms', async (req, res) => {
    const parsed = createSchema.safeParse(req.body); if (!parsed.success) { res.status(400).json({ error: '请输入有效昵称和 0–5 名电脑。' }); return; }
    try {
      rate(`create:${req.socket.remoteAddress}`, 20); requireRule(rooms.size < 1000, '房间数量已达单实例上限。');
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let code: string; do { code = Array.from({length:6}, () => alphabet[randomInt(alphabet.length)]).join(''); } while (rooms.has(code));
      const { room, session } = makeRoom(code, parsed.data.name, parsed.data.bots, Date.now());
      await store.create(room); rooms.set(code, room); res.status(201).json({ session });
    } catch (error) { res.status(error instanceof GameError ? 400 : 503).json(errorReply(error)); }
  });
  app.post('/api/rooms/:code/join', async (req, res) => {
    const parsed = joinSchema.safeParse(req.body); if (!parsed.success) { res.status(400).json({ error: '请输入昵称。' }); return; }
    const code = req.params.code.toUpperCase();
    await locked(code, async () => {
      try {
        rate(`join:${req.socket.remoteAddress}`, 30);
        const previous = getRoom(code), room = structuredClone(previous);
        requireRule(room.status === 'lobby', '本局已经开始，无法中途加入。');
        requireRule(room.players.length < 6, '房间已满。');
        const { player, token } = makePlayer(parsed.data.name);
        requireRule(!room.players.some(p => p.name === player.name), '昵称已被使用，请换一个。');
        room.players.push(player); room.revision++; room.updatedAt = Date.now(); log(room, `${player.name} 加入了越狱计划。`, Date.now());
        await commit(previous, room, player.id, randomUUID(), 'join', { name: player.name });
        res.json({ session: { room: code, playerId: player.id, token } });
      } catch (error) { res.status(error instanceof GameError ? 400 : 503).json(errorReply(error)); }
    });
  });
  app.get('/api/rooms/:code/history', async (req, res) => {
    try {
      const parsed = sessionSchema.safeParse({ room: req.params.code, playerId: req.headers['x-player-id'], token: req.headers.authorization?.replace(/^Bearer /, '') });
      requireRule(parsed.success && authorize(getRoom(req.params.code), parsed.data.playerId, parsed.data.token), '身份验证失败。');
      res.json({ events: await store.events(req.params.code), results: await store.results(req.params.code) });
    } catch { res.status(403).json({ error: '身份验证失败。' }); }
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在。' }));
  io.use((socket, next) => {
    try {
      rate(`connect:${socket.handshake.address}`, 120);
      const parsed = sessionSchema.safeParse(socket.handshake.auth);
      requireRule(parsed.success && authorize(getRoom(parsed.data.room), parsed.data.playerId, parsed.data.token), '身份验证失败或房间不存在。');
      socket.data.session = parsed.data; next();
    } catch (error) { next(new Error(error instanceof Error ? error.message : '连接失败。')); }
  });
  io.on('connection', socket => {
    const session: Session = socket.data.session, key = `${session.room}:${session.playerId}`;
    if (!online.has(key)) online.set(key, new Set()); online.get(key)!.add(socket.id);
    broadcast(session.room);
    socket.on('sync', () => { try { rate(`sync:${key}`, 120); broadcast(session.room); } catch {} });
    socket.on('command', async (raw, ack) => {
      const reply = await command(session, raw); if (typeof ack === 'function') ack(reply);
    });
    socket.on('disconnect', () => { online.get(key)?.delete(socket.id); if (!online.get(key)?.size) online.delete(key); broadcast(session.room); });
  });
  let ticking = false;
  const timer = setInterval(async () => {
    if (ticking || closing) return; ticking = true;
    try {
      for (const code of rooms.keys()) {
        if (closing) break;
        const candidate = rooms.get(code)!; if (candidate.status !== 'playing') continue;
        await locked(code, async () => {
          const room = getRoom(code), now = Date.now();
          const expired = timeoutRoom(room, now, turnMs);
          if (expired) { await commit(room, expired, 'system', randomUUID(), 'timeout', {}); return; }
          const actor = room.combat?.responder ?? room.players[room.turnIndex].id;
          if (!room.players.find(p => p.id === actor)?.bot) return;
          const action = botAction(room, actor);
          const next = applyAction(room, actor, action, { now, turnMs });
          await commit(room, next, actor, randomUUID(), action.type, action);
        });
      }
      for (const [key, value] of rates) if (value.reset < Date.now()) rates.delete(key);
    } catch (error) { console.error('Game tick error:', error); } finally { ticking = false; }
  }, options.tickMs ?? 800);
  timer.unref();
  let vite: Awaited<ReturnType<typeof import('vite')['createServer']>> | undefined;
  if (options.production) {
    app.use(express.static(resolve('dist'), { maxAge: '1h', index: false }));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
  } else {
    const { createServer: createViteServer } = await import('vite');
    vite = await createViteServer({ server: { middlewareMode: true, hmr: { server: http } }, appType: 'spa' });
    app.use(vite.middlewares);
  }
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error?.status === 400 || error?.status === 413 ? error.status : 500).json({ error: '请求无效或服务暂时不可用。' }); });
  return { app, http, io, store, rooms, command,
    async listen(port = 3000, host = '127.0.0.1') { await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(port, host, () => { http.off('error', reject); resolve(); }); }); return (http.address() as import('node:net').AddressInfo).port; },
    async close() {
      closing = true; clearInterval(timer); await Promise.allSettled([...locks.values()]);
      await new Promise<void>(resolve => io.close(() => resolve())); await vite?.close(); await store.close();
    },
  };
}
