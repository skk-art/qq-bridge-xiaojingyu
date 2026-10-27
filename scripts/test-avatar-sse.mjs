// 实测虚拟形象 SSE 事件流：连上 → 收 hello → 触发一次真实回合 → 收 message/turn/reply 事件
import fs from 'node:fs';

const TOKEN = fs.readFileSync('E:/qq-bridge/state/console-token', 'utf8').trim();
const BASE = 'http://127.0.0.1:3100';
const KEY = 'private:2132380007';
const DEADLINE_MS = 100000;

const ac = new AbortController();
const killer = setTimeout(() => ac.abort(), DEADLINE_MS + 5000);

const seen = [];
const res = await fetch(`${BASE}/api/avatar/events?token=${encodeURIComponent(TOKEN)}`, {
  headers: { accept: 'text/event-stream' },
  signal: ac.signal,
});
console.log('HTTP', res.status, '|', res.headers.get('content-type'));
if (!res.ok) { console.log('❌ 连接失败'); process.exit(1); }

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let triggered = false;
const t0 = Date.now();

try {
  while (Date.now() - t0 < DEADLINE_MS) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });

    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const ev = JSON.parse(line.slice(5).trim());
        seen.push(ev);
        console.log(`[${ev.type}] seq=${ev.seq}`, JSON.stringify(ev.data).slice(0, 200));
      }
    }

    if (!triggered && seen.some((e) => e.type === 'hello')) {
      triggered = true;
      console.log('\n>>> 收到 hello，触发一次真实回合（notify-ai）…\n');
      await fetch(`${BASE}/api/console/notify-ai`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-console-token': TOKEN },
        body: JSON.stringify({ key: KEY, message: '【接口自测】请只回一句：形象接口测试通过' }),
      });
      console.log('>>> notify-ai 已发出，等事件…\n');
    }
    if (seen.some((e) => e.type === 'reply.out')) { console.log('\n>>> 收到 reply.out，测试通过'); break; }
  }
} catch (e) {
  console.log('（流结束/中断）', e?.name ?? e);
}

clearTimeout(killer);
console.log('\n=== 收到的事件类型 ===');
console.log([...new Set(seen.map((e) => e.type))].join(', ') || '(无)');
try { await reader.cancel(); } catch {}
process.exit(0);
