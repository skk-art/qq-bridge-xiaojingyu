// 验证 B站 MCP 工具是否真的进入了 DSH 会话的工具面。
// 做法：建一个 qq-chat-v2 会话 → 发一条 prompt → 从会话日志的 request/header 里读出工具清单。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const mod = await import(new URL('../src/dsh-client.js', import.meta.url).href);
const { NodeApiClient, unwrap } = mod;

const BASE = 'http://127.0.0.1:3080';
const cwd = path.join(os.tmpdir(), 'bili-tools-probe');
fs.mkdirSync(cwd, { recursive: true });

const api = new NodeApiClient(BASE, undefined, {});
await api.ensureAuth();
console.log('✅ 已鉴权');

const created = unwrap(await api.sessions.create({ cwd, agentPreset: 'qq-chat-v2' }), 'session.create');
const sessionId = created.sessionId;
console.log('✅ 会话:', sessionId);

unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: '在吗' }] }), 'prompt');
console.log('✅ 已发 prompt，等 25 秒…');
await new Promise((r) => setTimeout(r, 25000));

// 找到这个会话的日志文件
const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions');
let logFile = null;
for (const ws of fs.readdirSync(sessionsRoot)) {
  const p = path.join(sessionsRoot, ws, sessionId, 'session.v4.jsonl.zstd');
  if (fs.existsSync(p)) { logFile = p; break; }
}
if (!logFile) { console.log('❌ 找不到会话日志'); process.exit(1); }
console.log('✅ 会话日志:', logFile);

const raw = zlib.zstdDecompressSync(fs.readFileSync(logFile)).toString('utf8');
const lines = raw.split('\n').filter(Boolean);

let tools = null;
for (const line of lines) {
  let ev; try { ev = JSON.parse(line); } catch { continue; }
  if (ev.type === 'request/header' && ev.data?.header?.tools) { tools = ev.data.header.tools; }
}

if (!tools) { console.log('❌ 没找到 request/header 里的工具清单'); process.exit(1); }

const names = tools.map((t) => t.name);
console.log(`\n✅ 该会话共 ${names.length} 个工具`);
const bili = names.filter((n) => n.toLowerCase().includes('bili'));
console.log(`\n=== B站工具（${bili.length} 个）===`);
for (const n of bili) console.log('   ', n);

console.log('\n=== 其他 MCP 工具 ===');
for (const n of names.filter((n) => n.startsWith('mcp__') && !n.toLowerCase().includes('bili'))) console.log('   ', n);

console.log('\n=== 是否混入了本地危险工具 ===');
const danger = names.filter((n) => /^(bash|pwsh|read|write|edit|exec|terminal_|str_replace)/.test(n));
console.log(danger.length ? '⚠️ ' + danger.join(', ') : '✅ 无');

// 清理：归档探测会话
try {
  await fetch(`${BASE}/api/session/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: String(mod.discoverDshSessionCookie(BASE)) },
    body: JSON.stringify({ type: 'client-request', rpcId: 'x', method: 'session/stop', payload: { args: { sessionId } } }),
  });
} catch {}
console.log('\n（探测会话已留在临时工作区，可忽略）');
