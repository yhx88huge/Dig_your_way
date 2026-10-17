import 'dotenv/config';
import { createApplication } from './app.js';
const seconds = Number(process.env.TURN_SECONDS ?? 90);
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(seconds) || seconds < 15 || seconds > 3600) throw new Error('PORT 或 TURN_SECONDS 配置无效。');
const server = await createApplication({ dataDir: process.env.DATA_DIR ?? 'data', databaseUrl: process.env.DATABASE_URL, production: process.argv.includes('--production'), turnMs: seconds * 1000, allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean) });
await server.listen(port, process.env.HOST ?? '127.0.0.1');
console.log(`\n掘地出笼已启动 → http://${process.env.HOST ?? '127.0.0.1'}:${port}\n持久化：${server.store.mode}\n按 Ctrl+C 安全停止。\n`);
let exiting = false;
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal, async () => {
  if (exiting) return; exiting = true;
  try { await server.close(); process.exit(0); } catch (error) { console.error(error); process.exit(1); }
});
