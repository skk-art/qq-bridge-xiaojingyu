// 用 MCP stdio 客户端实测 bilibili MCP server：握手 → 列工具 → 真调几个工具。
// 与 test-mcp-servers-stdio.mjs 同套路，只是目标是 B站 服务器。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const NO_PROXY = 'bilibili.com,hdslb.com,127.0.0.1,localhost';

const transport = new StdioClientTransport({
  command: NODE,
  args: [path.join(ROOT, 'src/mcp-bilibili.js')],
  cwd: ROOT,
  stderr: 'pipe',
  env: { ...process.env, no_proxy: NO_PROXY, NO_PROXY },
});
const client = new Client({ name: 'bili-mcp-probe', version: '0.0.0' });

await client.connect(transport);
console.log('✅ 握手成功');

const { tools } = await client.listTools();
console.log('✅ 工具数:', tools.length);
for (const t of tools) console.log('   -', t.name);

const bad = tools.map((t) => t.name).filter((n) => !/^[A-Za-z0-9_-]{1,64}$/.test(n));
if (bad.length) console.log('⚠️ 不符合 DSH 工具名契约:', bad.join(', '));

async function call(name, args) {
  console.log(`\n=== ${name} ${JSON.stringify(args)} ===`);
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    if (r.isError) { console.log('❌ 工具报错:', text.slice(0, 300)); return; }
    console.log(JSON.stringify(JSON.parse(text), null, 1).slice(0, 800));
  } catch (e) {
    console.log('❌ 异常:', e.message);
  }
}

await call('bili_search_video', { keyword: 'DeepSeek 小鲸鱼', page: 1 });
await call('bili_video_info', { bvid: 'BV1GJ411x7h7' });
await call('bili_hot', { type: 'hotsearch', limit: 5 });
await call('bili_video_danmaku', { bvid: 'BV1GJ411x7h7', limit: 5 });
await call('bili_video_comments', { bvid: 'BV1GJ411x7h7', limit: 3 });
await call('bili_related', { bvid: 'BV1GJ411x7h7', limit: 3 });

await client.close();
console.log('\n✅ 测试结束');
