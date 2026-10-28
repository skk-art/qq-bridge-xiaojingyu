// B站（哔哩哔哩）只读 MCP server（stdio）。
// 由 DSH 的 MCP 客户端 spawn（cordis.patch.yml 里 mcp-bilibili 行）。
//
// 全部工具**只读**：搜索、看视频信息、读评论、读弹幕、看相关推荐、看热门/排行/热搜，
// 以及登录后可见的 UP主资料/投稿、我的信息/关注/动态/稍后再看/观看历史。
// **不写任何东西**：不发帖、不评论、不发弹幕、不点赞、不关注。
//
// 匿名可用（2026-10-27 实测）：
//   ✅ 视频信息 view / 热门 popular / 排行榜 ranking / 每周必看 / 热搜 square / 相关推荐 related
//   ✅ 搜索  —— 必须走 wbi 路径并带 WBI 签名（旧路径 /x/web-interface/search/type 会被风控挡成 HTML）
//   ✅ 评论 reply / 弹幕 dm
// 需要登录（config.json 的 bilibili.sessdata）：
//   UP主资料、UP主投稿、我的信息、我的关注、我的动态、稍后再看、观看历史
//
// 所有网络请求均直连 api.bilibili.com（显式绕过本机代理）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// 本机若配了代理（Clash 等），B站是境内站点，直连更快也更不容易被风控误判。
process.env.no_proxy = [process.env.no_proxy, 'bilibili.com', 'hdslb.com', '127.0.0.1', 'localhost']
  .filter(Boolean).join(',');
process.env.NO_PROXY = process.env.no_proxy;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE_H = {
  'User-Agent': UA,
  Referer: 'https://www.bilibili.com',
  Origin: 'https://www.bilibili.com',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};
const TIMEOUT_MS = 15000;

// ── 凭据：从 <repo>/config.json 的 bilibili 段读取（该文件被 .gitignore 排除，不会入库）──────
//   { "bilibili": { "sessdata": "…", "biliJct": "…", "buvid3": "…" } }
// 只有需要登录的只读工具会用到；匿名工具不受影响。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function readCreds() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const b = JSON.parse(text)?.bilibili ?? {};
    return {
      sessdata: String(b.sessdata ?? '').trim(),
      biliJct: String(b.biliJct ?? '').trim(),
      buvid3: String(b.buvid3 ?? '').trim(),
    };
  } catch {
    return { sessdata: '', biliJct: '', buvid3: '' };
  }
}
function hasLogin() {
  return readCreds().sessdata.length > 0;
}
function requireLogin() {
  if (!hasLogin()) {
    throw new Error(
      '这个工具需要登录 B站。请在 E:\\qq-bridge\\config.json 里填 "bilibili": { "sessdata": "你的 SESSDATA" }，' +
      '然后重启 DSH 让 MCP 服务器重新读取配置。'
    );
  }
}

// ── WBI 签名 ────────────────────────────────────────────────────────────────
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const mixinKey = (orig) => MIXIN_TAB.map((n) => orig[n]).join('').slice(0, 32);

function encWbi(params, imgKey, subKey) {
  const k = mixinKey(imgKey + subKey);
  const p = { ...params, wts: Math.round(Date.now() / 1000) };
  const q = Object.keys(p).sort()
    .map((x) => `${encodeURIComponent(x)}=${encodeURIComponent(String(p[x]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return `${q}&w_rid=${md5(q + k)}`;
}

// ── 会话（匿名 cookie + WBI 密钥），带缓存 ──────────────────────────────────
let session = null;
let sessionAt = 0;
const SESSION_TTL_MS = 20 * 60 * 1000;

async function rawFetch(url, headers) {
  return fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

async function getSession(force = false) {
  const creds = readCreds();
  // 凭据变了（比如刚填上 SESSDATA）就重建会话，免得用户改完 config.json 还得重启 DSH。
  if (!force && session && session.sessdata === creds.sessdata && Date.now() - sessionAt < SESSION_TTL_MS) return session;
  const spi = await (await rawFetch('https://api.bilibili.com/x/frontend/finger/spi', BASE_H)).json();
  const parts = [
    `buvid3=${creds.buvid3 || spi.data.b_3}`,
    `buvid4=${spi.data.b_4}`,
    `b_nut=${Math.round(Date.now() / 1000)}`,
  ];
  // 登录态：有 SESSDATA 时带上，登录可见的接口才拿得到数据。
  if (creds.sessdata) parts.push(`SESSDATA=${creds.sessdata}`);
  if (creds.biliJct) parts.push(`bili_jct=${creds.biliJct}`);
  const cookie = parts.join('; ');
  const nav = await (await rawFetch('https://api.bilibili.com/x/web-interface/nav', { ...BASE_H, Cookie: cookie })).json();
  const imgKey = nav.data.wbi_img.img_url.split('/').pop().split('.')[0];
  const subKey = nav.data.wbi_img.sub_url.split('/').pop().split('.')[0];
  session = { cookie, imgKey, subKey, loggedIn: nav.data.isLogin === true, sessdata: creds.sessdata };
  sessionAt = Date.now();
  return session;
}

// 统一请求：自动带 cookie；wbi=true 时加签名；非 JSON（被风控挡成 HTML）时给出明确报错。
async function biliGet(path, params = {}, { wbi = false, retry = true } = {}) {
  const s = await getSession();
  const qs = wbi ? encWbi(params, s.imgKey, s.subKey) : new URLSearchParams(params).toString();
  const url = `https://api.bilibili.com${path}${qs ? `?${qs}` : ''}`;
  const res = await rawFetch(url, { ...BASE_H, Cookie: s.cookie });
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('json')) {
    if (retry) { await getSession(true); return biliGet(path, params, { wbi, retry: false }); }
    throw new Error(`B站返回了非 JSON（HTTP ${res.status}），通常是触发风控。请稍后重试，或减少请求频率。`);
  }
  const json = await res.json();
  if (json.code === -352 || json.code === -412) {
    if (retry) { await getSession(true); return biliGet(path, params, { wbi, retry: false }); }
    throw new Error(`B站风控拒绝（code=${json.code} ${json.message ?? ''}）。该接口需要登录，本工具不提供。`);
  }
  if (json.code !== 0) throw new Error(`B站接口错误 code=${json.code} ${json.message ?? ''}`);
  return json.data;
}

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: `调用失败：${e?.message ?? e}` }] });

// 统一的 BV 号清洗：允许用户/模型传完整 URL
function normBvid(input) {
  const m = String(input ?? '').match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : null;
}

async function videoByBvid(bvid) {
  const data = await biliGet('/x/web-interface/view', { bvid });
  return data;
}

// ── 工具定义 ────────────────────────────────────────────────────────────────
const server = new McpServer({ name: 'bilibili', version: '1.0.0' });

server.tool(
  'bili_search_video',
  '在 B站搜索视频。返回标题、BV号、UP主、播放量、时长、发布时间、简介片段。只读，无需登录。',
  { keyword: z.string().describe('搜索关键词'), page: z.number().int().min(1).max(20).optional().describe('页码，默认 1') },
  async ({ keyword, page }) => {
    try {
      const data = await biliGet('/x/web-interface/wbi/search/type',
        { search_type: 'video', keyword, page: page ?? 1 }, { wbi: true });
      const list = (data?.result ?? []).map((v) => ({
        bvid: v.bvid,
        title: String(v.title ?? '').replace(/<[^>]+>/g, ''),
        author: v.author,
        mid: v.mid,
        play: v.play,
        danmaku: v.video_review,
        duration: v.duration,
        pubdate: v.pubdate ? new Date(v.pubdate * 1000).toISOString().slice(0, 10) : null,
        url: v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : null,
        description: String(v.description ?? '').replace(/<[^>]+>/g, '').slice(0, 120),
      }));
      return ok({ keyword, page: page ?? 1, count: list.length, results: list });
    } catch (e) { return fail(e); }
  }
);

server.tool(
  'bili_video_info',
  '获取 B站视频的详细信息：标题、UP主、播放/点赞/投币/收藏/弹幕数、简介、分P列表、cid。接受 BV 号或完整视频链接。只读，无需登录。',
  { bvid: z.string().describe('BV 号或视频链接，例如 BV1GJ411x7h7 或 https://www.bilibili.com/video/BV1GJ411x7h7') },
  async ({ bvid }) => {
    try {
      const id = normBvid(bvid);
      if (!id) return fail(new Error('没能从输入里识别出 BV 号'));
      const d = await videoByBvid(id);
      return ok({
        bvid: d.bvid,
        aid: d.aid,
        title: d.title,
        author: d.owner?.name,
        mid: d.owner?.mid,
        url: `https://www.bilibili.com/video/${d.bvid}`,
        cover: d.pic,
        desc: String(d.desc ?? '').slice(0, 500),
        duration_sec: d.duration,
        pubdate: d.pubdate ? new Date(d.pubdate * 1000).toISOString() : null,
        stat: {
          view: d.stat?.view, like: d.stat?.like, coin: d.stat?.coin,
          favorite: d.stat?.favorite, danmaku: d.stat?.danmaku,
          reply: d.stat?.reply, share: d.stat?.share,
        },
        pages: (d.pages ?? []).map((p) => ({ page: p.page, part: p.part, cid: p.cid, duration: p.duration })),
      });
    } catch (e) { return fail(e); }
  }
);

server.tool(
  'bili_video_comments',
  '读取 B站视频的评论（按热度排序）。返回评论内容、作者、点赞数、回复数、时间。只读，无需登录。',
  {
    bvid: z.string().describe('BV 号或视频链接'),
    page: z.number().int().min(1).max(10).optional().describe('页码，默认 1'),
    limit: z.number().int().min(1).max(30).optional().describe('返回条数上限，默认 10'),
  },
  async ({ bvid, page, limit }) => {
    try {
      const id = normBvid(bvid);
      if (!id) return fail(new Error('没能识别出 BV 号'));
      const v = await videoByBvid(id);
      const data = await biliGet('/x/v2/reply', { type: 1, oid: v.aid, pn: page ?? 1, ps: 20, sort: 2 });
      const replies = (data?.replies ?? []).slice(0, limit ?? 10).map((r) => ({
        user: r.member?.uname,
        content: String(r.content?.message ?? '').slice(0, 400),
        like: r.like,
        replyCount: r.rcount,
        time: r.ctime ? new Date(r.ctime * 1000).toISOString() : null,
      }));
      return ok({ bvid: id, total: data?.page?.count ?? null, page: page ?? 1, comments: replies });
    } catch (e) { return fail(e); }
  }
);

server.tool(
  'bili_video_danmaku',
  '读取 B站视频的弹幕。返回弹幕文本与出现时间点。只读，无需登录。',
  {
    bvid: z.string().describe('BV 号或视频链接'),
    limit: z.number().int().min(1).max(200).optional().describe('返回条数上限，默认 50'),
  },
  async ({ bvid, limit }) => {
    try {
      const id = normBvid(bvid);
      if (!id) return fail(new Error('没能识别出 BV 号'));
      const v = await videoByBvid(id);
      const s = await getSession();
      const res = await rawFetch(`https://api.bilibili.com/x/v1/dm/list.so?oid=${v.cid}`, { ...BASE_H, Cookie: s.cookie });
      const buf = Buffer.from(await res.arrayBuffer());
      const head = buf.subarray(0, 20).toString('utf8');
      if (head.startsWith('<!DOCTYPE') || head.startsWith('<html')) {
        return fail(new Error('弹幕接口返回了 HTML（风控），请稍后重试'));
      }
      const xml = buf.toString('utf8');
      const items = [];
      for (const m of xml.matchAll(/<d p="([^"]*)">([^<]*)<\/d>/g)) {
        const parts = m[1].split(',');
        items.push({ time: Number(parts[0]) || 0, mode: Number(parts[1]) || 0, text: m[2] });
        if (items.length >= (limit ?? 50)) break;
      }
      return ok({ bvid: id, cid: v.cid, count: items.length, danmaku: items });
    } catch (e) { return fail(e); }
  }
);

server.tool(
  'bili_related',
  '获取 B站某个视频的相关推荐视频列表。只读，无需登录。',
  { bvid: z.string().describe('BV 号或视频链接'), limit: z.number().int().min(1).max(30).optional().describe('条数上限，默认 10') },
  async ({ bvid, limit }) => {
    try {
      const id = normBvid(bvid);
      if (!id) return fail(new Error('没能识别出 BV 号'));
      const list = await biliGet('/x/web-interface/archive/related', { bvid: id });
      const out = (list ?? []).slice(0, limit ?? 10).map((v) => ({
        bvid: v.bvid, title: v.title, author: v.owner?.name,
        view: v.stat?.view, url: `https://www.bilibili.com/video/${v.bvid}`,
      }));
      return ok({ bvid: id, count: out.length, related: out });
    } catch (e) { return fail(e); }
  }
);

server.tool(
  'bili_hot',
  '获取 B站的榜单类内容。type 可选：popular（综合热门）/ ranking（排行榜）/ weekly（每周必看）/ hotsearch（热搜词）。只读，无需登录。',
  {
    type: z.enum(['popular', 'ranking', 'weekly', 'hotsearch']).describe('榜单类型'),
    limit: z.number().int().min(1).max(30).optional().describe('条数上限，默认 10'),
  },
  async ({ type, limit }) => {
    try {
      const n = limit ?? 10;
      if (type === 'popular') {
        const d = await biliGet('/x/web-interface/popular', { ps: n, pn: 1 });
        return ok({ type, list: (d?.list ?? []).map((v) => ({ bvid: v.bvid, title: v.title, author: v.owner?.name, view: v.stat?.view, url: `https://www.bilibili.com/video/${v.bvid}` })) });
      }
      if (type === 'ranking') {
        const d = await biliGet('/x/web-interface/ranking/v2', { rid: 0, type: 'all' });
        return ok({ type, list: (d?.list ?? []).slice(0, n).map((v) => ({ bvid: v.bvid, title: v.title, author: v.owner?.name, score: v.score, url: `https://www.bilibili.com/video/${v.bvid}` })) });
      }
      if (type === 'weekly') {
        const d = await biliGet('/x/web-interface/popular/series/one', { number: 1 });
        return ok({ type, number: d?.number, list: (d?.list ?? []).slice(0, n).map((v) => ({ bvid: v.bvid, title: v.title, author: v.owner?.name, url: `https://www.bilibili.com/video/${v.bvid}` })) });
      }
      const d = await biliGet('/x/web-interface/search/square', { limit: n });
      return ok({ type, list: (d?.trending?.list ?? []).slice(0, n).map((x) => ({ keyword: x.keyword, show_name: x.show_name })) });
    } catch (e) { return fail(e); }
  }
);

// ── 以下工具需要登录（config.json 的 bilibili.sessdata）──────────────────────

server.tool(
  'bili_me',
  '查看当前登录的 B站账号信息：昵称、UID、等级、硬币、会员状态。需要已配置 SESSDATA。只读。',
  {},
  async () => {
    try {
      requireLogin();
      const s = await getSession(true);
      if (!s.loggedIn) return fail(new Error('SESSDATA 无效或已过期（B站返回未登录）。请重新获取 SESSDATA。'));
      const nav = await (await rawFetch('https://api.bilibili.com/x/web-interface/nav', { ...BASE_H, Cookie: s.cookie })).json();
      const d = nav.data ?? {};
      return ok({
        mid: d.mid, name: d.uname,
        level: d.level_info?.current_level,
        coins: d.money, vip: d.vipStatus === 1,
        vipType: d.vipType,
        url: d.mid ? `https://space.bilibili.com/${d.mid}` : null,
      });
    } catch (e) { return fail(e); }
  }
);

server.tool(
  'bili_user_info',
  '查看某个 UP主 的公开资料：昵称、签名、粉丝数、关注数、投稿数、等级、认证信息。需要登录（B站风控要求）。只读。',
  { mid: z.string().describe('UP主的 UID（数字）') },
  async ({ mid }) => {
    try {
      requireLogin();
      const d = await biliGet('/x/space/wbi/acc/info', { mid }, { wbi: true });
      return ok({
        mid: d.mid, name: d.name, sign: d.sign,
        level: d.level, sex: d.sex,
        fans: d.follower ?? d.fans, following: d.following,
        archiveCount: d.archive_count,
        official: d.official?.title ?? null,
        vip: d.vip?.label?.text ?? null,
        url: `https://space.bilibili.com/${d.mid}`,
      });
    } catch (e) { return fail(e); }
  }
);

server.tool(
  'bili_user_videos',
  '查看某个 UP主 的投稿视频列表（按发布时间倒序）。需要登录（B站风控要求）。只读。',
  {
    mid: z.string().describe('UP主的 UID（数字）'),
    page: z.number().int().min(1).max(30).optional().describe('页码，默认 1'),
    limit: z.number().int().min(1).max(50).optional().describe('条数上限，默认 10'),
  },
  async ({ mid, page, limit }) => {
    try {
      requireLogin();
      const d = await biliGet('/x/space/wbi/arc/search',
        { mid, ps: 30, pn: page ?? 1, order: 'pubdate', platform: 'web' }, { wbi: true });
      const list = (d?.list?.vlist ?? []).slice(0, limit ?? 10).map((v) => ({
        bvid: v.bvid, title: v.title, play: v.play, danmaku: v.video_review,
        length: v.length, created: v.created ? new Date(v.created * 1000).toISOString().slice(0, 10) : null,
        url: `https://www.bilibili.com/video/${v.bvid}`,
      }));
      return ok({ mid, total: d?.page?.count ?? null, page: page ?? 1, count: list.length, videos: list });
    } catch (e) { return fail(e); }
  }
);

server.tool(
  'bili_my_following',
  '查看当前登录账号的关注列表（我关注了谁）。需要已配置 SESSDATA。只读。',
  {
    page: z.number().int().min(1).max(50).optional().describe('页码，默认 1'),
    limit: z.number().int().min(1).max(50).optional().describe('条数上限，默认 20'),
  },
  async ({ page, limit }) => {
    try {
      requireLogin();
      const s = await getSession();
      const nav = await (await rawFetch('https://api.bilibili.com/x/web-interface/nav', { ...BASE_H, Cookie: s.cookie })).json();
      const myMid = nav.data?.mid;
      if (!myMid) return fail(new Error('拿不到自己的 UID，SESSDATA 可能已失效'));
      const d = await biliGet('/x/relation/followings', { vmid: myMid, ps: 50, pn: page ?? 1 });
      const list = (d?.list ?? []).slice(0, limit ?? 20).map((u) => ({
        mid: u.mid, name: u.uname, sign: u.sign,
        url: `https://space.bilibili.com/${u.mid}`,
      }));
      return ok({ total: d?.total ?? null, page: page ?? 1, count: list.length, following: list });
    } catch (e) { return fail(e); }
  }
);

server.tool(
  'bili_my_dynamics',
  '查看当前登录账号首页的动态流（关注的人发了什么）。需要已配置 SESSDATA。只读。',
  { limit: z.number().int().min(1).max(30).optional().describe('条数上限，默认 10') },
  async ({ limit }) => {
    try {
      requireLogin();
      const d = await biliGet('/x/polymer/web-dynamic/v1/feed/all', { type: 'all', page: 1 });
      const items = (d?.items ?? []).slice(0, limit ?? 10).map((it) => ({
        id: it.id_str,
        author: it.modules?.module_author?.name,
        type: it.type,
        text: String(it.modules?.module_dynamic?.desc?.text ?? it.modules?.module_dynamic?.major?.archive?.title ?? '').slice(0, 200),
        time: it.modules?.module_author?.pub_time,
      }));
      return ok({ count: items.length, hasMore: d?.has_more === true, dynamics: items });
    } catch (e) { return fail(e); }
  }
);

server.tool(
  'bili_toview',
  '查看当前登录账号的「稍后再看」列表。需要已配置 SESSDATA。只读。',
  { limit: z.number().int().min(1).max(50).optional().describe('条数上限，默认 20') },
  async ({ limit }) => {
    try {
      requireLogin();
      const d = await biliGet('/x/v2/history/toview', {});
      const list = (d?.list ?? []).slice(0, limit ?? 20).map((v) => ({
        bvid: v.bvid, title: v.title, author: v.owner?.name, duration: v.duration,
        progress: v.progress, addAt: v.add_at ? new Date(v.add_at * 1000).toISOString() : null,
        url: `https://www.bilibili.com/video/${v.bvid}`,
      }));
      return ok({ count: list.length, toview: list });
    } catch (e) { return fail(e); }
  }
);

server.tool(
  'bili_my_history',
  '查看当前登录账号的观看历史。需要已配置 SESSDATA。只读。',
  { limit: z.number().int().min(1).max(50).optional().describe('条数上限，默认 20') },
  async ({ limit }) => {
    try {
      requireLogin();
      const d = await biliGet('/x/v2/history', { ps: 30, pn: 1 });
      // 注意：这个接口的 data 直接就是数组，不是 { list: [...] }（实测 2026-10-27）。
      // 两种形状都兼容，免得哪天 B站又改回去。
      const raw = Array.isArray(d) ? d : (d?.list ?? []);
      const list = raw.slice(0, limit ?? 20).map((v) => ({
        bvid: v.bvid ?? v.history?.bvid, title: v.title, author: v.owner?.name,
        progress: v.progress, viewAt: v.view_at ? new Date(v.view_at * 1000).toISOString() : null,
        url: v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : null,
      }));
      return ok({ count: list.length, history: list });
    } catch (e) { return fail(e); }
  }
);

await server.connect(new StdioServerTransport());
