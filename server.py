"""Python 3.10+，标准库即可运行。默认只监听本机。"""
from __future__ import annotations

import argparse
import copy
import json
import re
import secrets
import sqlite3
import threading
import time
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import engine

BASE = Path(__file__).resolve().parent
CODE_RE = re.compile(r'^[A-HJ-NP-Z2-9]{6}$')
MAX_BODY = 16384


class ApiError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


class RoomStore:
    """锁覆盖读取、验证、更新和提交；SQLite 提交成功后才返回成功。"""
    def __init__(self, path):
        self.lock = threading.RLock()
        self.db = sqlite3.connect(str(path), check_same_thread=False, timeout=10)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, state TEXT NOT NULL, updated REAL NOT NULL)')
        self.db.commit()

    def _read(self, code):
        if not isinstance(code, str) or not CODE_RE.fullmatch(code):
            raise ApiError(400, '房间码应为 6 位大写字母或数字。')
        row = self.db.execute('SELECT state FROM rooms WHERE code=?', (code,)).fetchone()
        if not row:
            raise ApiError(404, '没有找到这个房间，请检查房间码。')
        room = json.loads(row[0])
        engine.validate(room)
        return room

    def _save(self, room):
        engine.validate(room)
        value = json.dumps(room, ensure_ascii=False, separators=(',', ':'))
        with self.db:
            self.db.execute('INSERT INTO rooms VALUES (?,?,?) ON CONFLICT(code) DO UPDATE SET state=excluded.state,updated=excluded.updated',
                            (room['code'], value, time.time()))

    @staticmethod
    def _auth(room, token):
        if not token or not isinstance(token, str):
            raise ApiError(401, '缺少玩家凭证，请重新加入房间。')
        player = engine.player_for_token(room, token)
        if not player:
            raise ApiError(403, '玩家凭证无效。请使用原浏览器继续游戏。')
        return player

    def create(self, name, bots):
        with self.lock:
            # 限制为本地原型的合理规模，避免误操作耗尽内存和磁盘。
            count = self.db.execute('SELECT COUNT(*) FROM rooms').fetchone()[0]
            if count >= 500:
                raise ApiError(409, '已达到 500 个房间上限，请备份后清理旧存档。')
            while True:
                code = ''.join(secrets.choice('ABCDEFGHJKLMNPQRSTUVWXYZ23456789') for _ in range(6))
                if not self.db.execute('SELECT 1 FROM rooms WHERE code=?', (code,)).fetchone():
                    break
            room, token = engine.new_room(code, name, bots)
            self._save(room)
            return {'token': token, 'room': engine.snapshot(room, room['owner'])}

    def join(self, code, name, token=None):
        with self.lock:
            room = self._read(code)
            player = engine.player_for_token(room, token) if isinstance(token, str) and token else None
            if player:
                return {'token': token, 'room': engine.snapshot(room, player['id'])}
            if room['status'] != 'waiting':
                raise ApiError(409, '游戏已经开始，新玩家暂时无法加入。原玩家可用原浏览器恢复。')
            engine.require(len(room['players']) < 6, '房间已满，可请房主移除一位电脑。')
            player = engine.new_player(name)
            room['players'].append(player)
            room['revision'] += 1
            self._save(room)
            return {'token': player['token'], 'room': engine.snapshot(room, player['id'])}

    def get(self, code, token):
        with self.lock:
            room = self._read(code)
            player = self._auth(room, token)
            return engine.snapshot(room, player['id'])

    def mutate(self, code, token, action):
        with self.lock:
            room = self._read(code)
            player = self._auth(room, token)
            request_id = action.get('requestId')
            if not isinstance(request_id, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{8,80}', request_id):
                raise ApiError(400, '请求编号无效。')
            receipt = player['id'] + ':' + request_id
            if receipt in room['receipts']:
                return engine.snapshot(room, player['id'])
            revision = action.get('revision')
            if type(revision) is not int or revision != room['revision']:
                raise ApiError(409, '局面已更新，本次操作未执行，请根据新局面重试。')
            kind = action.get('type')
            if kind in ('add_bot', 'remove_bot', 'start', 'restart'):
                engine.require(player['id'] == room['owner'], '只有房主可以操作。')
                if kind == 'restart':
                    engine.require(room['status'] == 'finished', '对局结束后才能再来一局。')
                    engine.start_game(room)
                else:
                    engine.require(room['status'] == 'waiting', '开局后不能修改座位。')
                    if kind == 'add_bot':
                        engine.require(len(room['players']) < 6, '房间已满。')
                        used = {p['name'] for p in room['players']}
                        name = next((n for n in engine.BOT_NAMES if n not in used), '电脑')
                        room['players'].append(engine.new_player(name, True))
                    elif kind == 'remove_bot':
                        target = next((p for p in room['players'] if p['id'] == action.get('target') and p['bot']), None)
                        engine.require(target is not None, '只能移除电脑玩家。')
                        room['players'].remove(target)
                    else:
                        engine.start_game(room)
                room['revision'] += 1
            elif kind == 'autoplay':
                engine.require(room['status'] == 'playing', '当前不在游戏中。')
                engine.require(type(action.get('enabled')) is bool, '托管参数无效。')
                player['bot'] = action['enabled']
                engine.add_log(room, player['name'] + ('开启了电脑托管。' if player['bot'] else '恢复了手动操作。'))
                room['revision'] += 1
            else:
                engine.require(not player['bot'], '请先关闭托管，再手动操作。')
                room = engine.apply_action(room, player['id'], action)
            room['receipts'].append(receipt)
            room['receipts'] = room['receipts'][-128:]
            self._save(room)
            return engine.snapshot(room, player['id'])

    def bot_tick(self):
        with self.lock:
            rows = self.db.execute('SELECT code FROM rooms').fetchall()
            for (code,) in rows:
                try:
                    room = self._read(code)
                    if room['status'] != 'playing':
                        continue
                    player = room['players'][room['game']['turn']]
                    if not player['bot']:
                        continue
                    action = engine.choose_bot_action(room)
                    room = engine.apply_action(room, player['id'], action)
                    self._save(room)
                except Exception as error:
                    # 一间房的异常不会停止其他房间；保留原存档并记录错误。
                    print(f'[电脑行动失败] {code}: {error}', flush=True)

    def close(self):
        with self.lock:
            self.db.close()


class GameServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, store):
        self.store = store
        super().__init__(address, partial(Handler, directory=str(BASE / 'dist')))


class Handler(SimpleHTTPRequestHandler):
    server_version = 'Blackgate/1.0'

    def log_message(self, fmt, *args):
        # 不输出玩家凭证；轮询成功不刷屏。
        if len(args) > 1 and str(args[1]) not in ('200', '304'):
            print('[HTTP]', fmt % args, flush=True)

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
        super().end_headers()

    def json_response(self, status, data):
        body = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def token(self):
        auth = self.headers.get('Authorization', '')
        return auth[7:] if auth.startswith('Bearer ') else ''

    def do_GET(self):
        path = urlsplit(self.path).path
        if not path.startswith('/api/'):
            # 仅发布 dist 内文件，禁止目录列表。
            if path.endswith('/') and path != '/':
                self.send_error(404)
                return
            if path == '/favicon.ico':
                self.send_response(204)
                self.end_headers()
                return
            return super().do_GET()
        try:
            if path == '/api/health':
                return self.json_response(200, {'ok': True, 'version': engine.VERSION})
            if path == '/api/config':
                return self.json_response(200, {'cards': engine.CARDS, 'locations': engine.LOCATIONS, 'recipes': engine.RECIPES})
            match = re.fullmatch(r'/api/rooms/([A-Z2-9]{6})', path)
            if not match:
                raise ApiError(404, '接口不存在。')
            self.json_response(200, {'room': self.server.store.get(match[1], self.token())})
        except (ApiError, engine.RuleError) as error:
            self.json_response(getattr(error, 'status', 400), {'error': getattr(error, 'message', str(error))})
        except Exception:
            self.json_response(500, {'error': '服务暂时异常，已保留上次成功的存档。请稍后重试。'})

    def do_POST(self):
        try:
            # 同源检查，避免其他网页向本地服务提交行动。
            origin = self.headers.get('Origin')
            if origin and urlsplit(origin).netloc != self.headers.get('Host'):
                raise ApiError(403, '不接受来自其他网站的请求。')
            if self.headers.get('Transfer-Encoding'):
                raise ApiError(400, '不支持分块请求。')
            try:
                length = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                raise ApiError(400, '请求长度无效。')
            if length < 1 or length > MAX_BODY:
                raise ApiError(413, '请求过大或为空。')
            if self.headers.get('Content-Type', '').split(';')[0].strip() != 'application/json':
                raise ApiError(415, '请使用 JSON 请求。')
            try:
                body = json.loads(self.rfile.read(length).decode('utf-8'))
            except (ValueError, UnicodeError):
                raise ApiError(400, 'JSON 格式错误。')
            if not isinstance(body, dict):
                raise ApiError(400, '请求应为 JSON 对象。')
            path = urlsplit(self.path).path
            if path == '/api/rooms':
                result = self.server.store.create(body.get('name'), body.get('bots', 3))
            elif path == '/api/rooms/join':
                result = self.server.store.join(str(body.get('code', '')).upper(), body.get('name'), body.get('token'))
            else:
                match = re.fullmatch(r'/api/rooms/([A-Z2-9]{6})/action', path)
                if not match:
                    raise ApiError(404, '接口不存在。')
                result = {'room': self.server.store.mutate(match[1], self.token(), body)}
            self.json_response(200, result)
        except (ApiError, engine.RuleError) as error:
            self.json_response(getattr(error, 'status', 400), {'error': getattr(error, 'message', str(error))})
        except Exception as error:
            print(f'[请求失败] {type(error).__name__}: {error}', flush=True)
            self.json_response(500, {'error': '保存操作失败，本次行动未确认。请等待恢复连接后刷新局面。'})

    def list_directory(self, path):
        self.send_error(404)
        return None


def main():
    parser = argparse.ArgumentParser(description='掘地出笼 · 本地桌游服务器')
    parser.add_argument('--host', default='127.0.0.1', help='默认仅本机；局域网可使用 0.0.0.0')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--open', action='store_true', help='启动后用默认浏览器打开')
    args = parser.parse_args()
    data_dir = BASE / 'data'
    data_dir.mkdir(exist_ok=True)
    store = RoomStore(data_dir / 'rooms.sqlite3')
    try:
        server = GameServer((args.host, args.port), store)
    except OSError as error:
        store.close()
        parser.exit(1, f'无法启动：{error}\n可用 --port 8766 换一个端口。\n')
    stop = threading.Event()

    def bot_loop():
        while not stop.wait(0.65):
            try:
                store.bot_tick()
            except Exception as error:
                print(f'[电脑线程] {error}', flush=True)

    worker = threading.Thread(target=bot_loop, daemon=True)
    worker.start()
    url = f'http://127.0.0.1:{server.server_port}'
    print(f'掘地出笼已启动：{url}\n按 Ctrl+C 停止；对局会自动保存。', flush=True)
    if args.host == '0.0.0.0':
        print('局域网玩家请访问本机的局域网 IP 和相同端口。', flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        worker.join(timeout=3)
        server.server_close()
        store.close()


if __name__ == '__main__':
    main()
