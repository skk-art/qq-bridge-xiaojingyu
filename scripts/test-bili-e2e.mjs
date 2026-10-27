// 端到端实测：让挂了 qq-chat-v2 预设的 DSH 会话真的去调 B站 MCP 工具，看能否拿到真实数据。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const mod = await import(new URL('../src/dsh-client.js', import.meta.url).href);
const { NodeApiClient, unwrap } = mod;

const BASE = 'http://127.0.0.1:3080';
const cwd = path.join(os.tmpdir(), 'bili-e2e-probe');
fs.mkdirSync(cwd, { recursive: true });

const api = new NodeApiClient(BASE, undefined, {});
await api.ensureAuth();

const created = unwrap(await api.sessions.create({ cwd, agentPreset: 'qq-chat-v2' }), 'session.create');
const sessionId = created.sessionId;
console.log('✅ 会话:', sessionId);

const ASK = '请调用 mcp__bilibili__bili_hot（type=hotsearch, limit=5）看一下B站现在热搜是什么，然后用一句话告诉我前三个。';
unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: ASK }] }), 'prompt');
console.log('✅ 已发 prompt，等 70 秒…');
await new Promise((r) => setTimeout(r, 70000));

const sessionsRoot = path.join(os.homedir(), '.dsh', 'sessions');
let logFile = null;
for (const ws of fs.readdirSync(sessionsRoot)) {
  const p = path.join(sessionsRoot, ws, sessionId, 'session.v4.jsonl.zstd');
  if (fs.existsSync(p)) { logFile = p; break; }
}
const raw = zlib.zstdDecompressSync(fs.readFileSync(logFile)).toString('utf8');

let calls = [], results = [], reply = null, endReason = null;
for (const line of raw.split('\n').filter(Boolean)) {
  let ev; try { ev = JSON.parse(line); } catch { continue; }
  if (ev.type === 'tool/call' && ev.data?.name?.includes('bili')) {
    calls.push({ name: ev.data.name, args: String(ev.data.arguments ?? '').slice(0, 160) });
  }
  if (ev.type === 'tool/result' && ev.data?.message?.toolCallId) {
    const t = ev.data.message?.content?.[0]?.text ?? '';
    if (t.includes('keyword') || t.includes('bvid') || t.includes('list')) results.push(t.slice(0, 500));
  }
  if (ev.type === 'assistant/message') {
    const blocks = ev.data?.message?.content ?? [];
    const txt = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (txt) reply = txt;
  }
  if (ev.type === 'turn/end') endReason = JSON.stringify(ev.data?.reason);
}

console.log('\n=== 回合结束 ===', endReason);
console.log('\n=== B站工具调用 ===');
if (!calls.length) console.log('❌ 没有观察到 B站工具调用');
for (const c of calls) console.log('  →', c.name, c.args);

console.log('\n=== 工具返回（片段）===');
if (!results.length) console.log('（无）');
for (const r of results) console.log(r, '\n---');

console.log('\n=== 模型回复 ===');
console.log(reply ?? '（无文本）');
