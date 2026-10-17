import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import lockfile from 'proper-lockfile';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Room } from '../shared/game.js';
import { GameError } from './engine.js';

type Query = { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> };
const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY, revision INTEGER NOT NULL, state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS game_events (
  room_code TEXT NOT NULL REFERENCES rooms(code), revision INTEGER NOT NULL,
  player_id TEXT NOT NULL, command_id TEXT NOT NULL, kind TEXT NOT NULL,
  payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (room_code, revision), UNIQUE(room_code, player_id, command_id)
);
CREATE TABLE IF NOT EXISTS game_results (
  game_id TEXT PRIMARY KEY, room_code TEXT NOT NULL REFERENCES rooms(code),
  winner_id TEXT NOT NULL, turns INTEGER NOT NULL, result JSONB NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS rooms_updated_at_idx ON rooms(updated_at);
`;
export class Store {
  private constructor(private db: PGlite | pg.Pool, public mode: 'postgresql'|'pglite', private release?: () => Promise<void>) {}
  static async open(options: { databaseUrl?: string; dataDir?: string } = {}) {
    let store: Store;
    if (options.databaseUrl) {
      const pool = new pg.Pool({ connectionString: options.databaseUrl, max: 5, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
      pool.on('error', error => console.error('PostgreSQL connection error:', error.message));
      store = new Store(pool, 'postgresql');
    }
    else {
      const directory = options.dataDir === ':memory:' ? undefined : resolve(options.dataDir ?? 'data');
      let release: (() => Promise<void>) | undefined;
      if (directory) {
        await mkdir(directory, { recursive: true });
        try { release = await lockfile.lock(directory, { stale: 30000, update: 10000, retries: 0 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ELOCKED') throw new Error('这份存档正在被另一个游戏进程使用，请关闭原窗口，或等待异常退出的锁在 30 秒后失效。'); throw error; }
      }
      try { store = new Store(new PGlite(directory), 'pglite', release); }
      catch (error) { await release?.(); throw error; }
    }
    try { if (store.db instanceof PGlite) await store.db.exec(SCHEMA); else await store.db.query(SCHEMA); }
    catch (error) { await store.close(); throw error; }
    return store;
  }
  private async transaction<T>(fn: (tx: Query) => Promise<T>): Promise<T> {
    if (this.db instanceof PGlite) return this.db.transaction(tx => fn(tx as Query));
    const client = await this.db.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  private async query(sql: string, params?: any[]) {
    if (this.db instanceof PGlite) return this.db.query(sql, params);
    return this.db.query(sql, params);
  }
  async loadRooms(): Promise<Room[]> {
    const result = await this.query('SELECT state FROM rooms ORDER BY updated_at DESC LIMIT 1000');
    return result.rows.map((r: any) => r.state as Room);
  }
  async receipt(code: string, playerId: string, commandId: string): Promise<number | null> {
    const result = await this.query('SELECT revision FROM game_events WHERE room_code=$1 AND player_id=$2 AND command_id=$3', [code, playerId, commandId]);
    return result.rows.length ? (result.rows[0] as any).revision : null;
  }
  async create(room: Room) {
    await this.query('INSERT INTO rooms(code,revision,state) VALUES($1,$2,$3::jsonb)', [room.code, room.revision, JSON.stringify(room)]);
  }
  async save(previous: Room, next: Room, playerId: string, commandId: string, kind: string, payload: unknown) {
    await this.transaction(async tx => {
      const update = await tx.query('UPDATE rooms SET revision=$1,state=$2::jsonb,updated_at=NOW() WHERE code=$3 AND revision=$4 RETURNING code', [next.revision, JSON.stringify(next), next.code, previous.revision]);
      if (!update.rows.length) throw new GameError('房间状态已更新，请重连后重试。', 'STALE_STATE');
      await tx.query('INSERT INTO game_events(room_code,revision,player_id,command_id,kind,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [next.code, next.revision, playerId, commandId, kind, JSON.stringify(payload)]);
      if (next.status === 'finished' && previous.status !== 'finished') {
        await tx.query('INSERT INTO game_results(game_id,room_code,winner_id,turns,result) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(game_id) DO NOTHING', [next.gameId, next.code, next.winner, next.turn, JSON.stringify(next.players.map(p => ({ id: p.id, name: p.name, tunnel: p.tunnel })))]);
      }
    });
  }
  async events(code: string) {
    const result = await this.query('SELECT revision,kind,created_at FROM game_events WHERE room_code=$1 ORDER BY revision DESC LIMIT 100', [code]); return result.rows;
  }
  async results(code: string) {
    const result = await this.query('SELECT game_id,winner_id,turns,result,finished_at FROM game_results WHERE room_code=$1 ORDER BY finished_at DESC LIMIT 20', [code]); return result.rows;
  }
  async close() {
    try { if (this.db instanceof PGlite) await this.db.close(); else await this.db.end(); }
    finally { await this.release?.(); this.release = undefined; }
  }
}
