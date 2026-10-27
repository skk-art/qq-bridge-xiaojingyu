# 虚拟形象（Avatar UI）接口

给外部的「虚拟形象 UI」用的接口 —— 一个 Live2D / VRM / 网页形象可以订阅机器人的
实时动作，跟着做表情、动嘴、显示状态。

**两个方向：**

| 方向 | 用途 | 接口 |
| --- | --- | --- |
| **观察**（机器人 → 形象） | 形象跟着机器人动：收到消息、开始思考、开口说话、发表情 | `GET /api/avatar/events`（SSE 事件流） |
| **控制**（形象 → 机器人） | 形象侧触发机器人说话，或把一条事件塞进它的上下文 | `POST /api/send/*`、`POST /api/console/notify-ai` |

所有接口都挂在**本机控制台端口**上（默认 `127.0.0.1:3100`），只监听回环地址，
**需要控制台令牌**（`config.json` 的 `consoleToken`，未配置时自动生成并存在 `state/console-token`）。

令牌可以放在 `?token=` 查询参数里，也可以放 `x-console-token` 请求头。

---

## 一、观察：SSE 事件流

```
GET http://127.0.0.1:3100/api/avatar/events?token=<控制台令牌>
```

标准 Server-Sent Events。`Content-Type: text/event-stream`，每条事件是一行 `data:` 加一个 JSON。

```js
const es = new EventSource('http://127.0.0.1:3100/api/avatar/events?token=你的令牌');
es.onmessage = (e) => {
  const ev = JSON.parse(e.data);
  switch (ev.type) {
    case 'reply.out': avatar.speak(ev.data.segments); break;
    case 'turn.start': avatar.thinking(true); break;
    // ...
  }
};
```

### 事件信封

```jsonc
{
  "seq": 42,              // 本进程内单调递增，可用来检测丢帧
  "ts": 1793019888198,    // 毫秒时间戳
  "type": "reply.out",    // 见下表
  "data": { /* 按 type 而定 */ }
}
```

### 事件类型

| `type` | 何时发出 | `data` 字段 |
| --- | --- | --- |
| `hello` | 刚连上时发一次 | `mode`（`chat`/`closed-agent`/`reserved`/`reserved2`）、`paused`、`conversations`（当前会话 key 数组）、`presets` |
| `message.in` | QQ 收到一条消息 | `key`（`private:QQ号` 或 `group:群号`）、`from`（`private`/`group`）、`text`（截断到 500 字） |
| `turn.start` | 一条消息已投递给模型，开始这一回合 | `key`、`reason` |
| `reply.out` | 机器人把回复发到了 QQ | `key`、`segments`（字符串数组，**按条分好**，适合逐条驱动口型/气泡） |
| `sticker.out` | 机器人发了一个表情包 | `key`、`stickerId`、`label` |

另外每 25 秒发一行 SSE 注释 `: hb`（心跳，用于探活；`EventSource` 会自动忽略）。

### 用 `seq` 判断丢帧

`seq` 是**桥接进程内**的全局序号。如果你收到 `seq` 跳号，说明中间有事件没送到
（SSE 断线重连、或你的消费者太慢）。对虚拟形象来说通常无所谓；如果要在意，
断线重连后重新对齐即可（`hello` 会给出当前快照）。

---

## 二、控制：让机器人说话 / 注入事件

这三个都是 `POST` + `application/json`。

### 2.1 让机器人在某个会话里说一句话

```http
POST /api/send/private        { "userId": "2132380007", "message": "在吗" }
POST /api/send/group          { "groupId": "1132346197", "message": "在吗" }
POST /api/send/reply          { "…": "见 bridge.js 的 /api/send/reply 分支" }
```

> ⚠️ 这是**以机器人的身份直接发消息**，不走模型。也就是说这句话不会经过人设与
> 安全审查。形象 UI 用它做「点一下让它说某句」没问题，但**不要**用它来代模型生成内容。

### 2.2 把一条事件塞进机器人的上下文（让它自己回应）

```http
POST /api/console/notify-ai
{ "key": "private:2132380007", "message": "【形象提醒】用户盯着屏幕看了很久没说话" }
```

`key` 必须是 `private:QQ号` 或 `group:群号`。机器人会把它当成一条输入处理，
**走完整的人设与安全链路**——想让形象影响机器人行为时用这个，而不是 2.1。

### 2.3 读当前状态（一次性，用于初始化）

```http
GET /api/status              # 模式、SnowLuma 连接状态等
GET /api/socialV2/states     # 各会话的仿真状态
GET /api/socialV2/activity   # 活动日志（控制台用）
```

---

## 三、最小可用示例

```html
<!doctype html>
<meta charset="utf-8">
<title>虚拟形象示例</title>
<div id="log"></div>
<script>
const TOKEN = prompt('控制台令牌（见 state/console-token）');
const es = new EventSource(`http://127.0.0.1:3100/api/avatar/events?token=${encodeURIComponent(TOKEN)}`);
const log = (s) => (document.getElementById('log').innerHTML += `<p>${s}</p>`);

es.onmessage = (e) => {
  const ev = JSON.parse(e.data);
  if (ev.type === 'hello') log(`连上了，当前模式 ${ev.data.mode}，会话 ${ev.data.conversations.length} 个`);
  if (ev.type === 'message.in') log(`📥 ${ev.data.key}：${ev.data.text}`);
  if (ev.type === 'reply.out') log(`💬 ${ev.data.key}：${ev.data.segments.join(' / ')}`);
  if (ev.type === 'sticker.out') log(`🖼 ${ev.data.key}：表情 ${ev.data.stickerId}`);
};
es.onerror = () => log('⚠️ 连接断开，EventSource 会自动重连');
</script>
```

---

## 四、设计约束（改这个接口前请先读）

1. **只读广播**：形象 UI 是观察者，不参与任何决策。事件的发送是 fire-and-forget，
   某个订阅者卡住/断开只摘掉它自己，绝不影响桥接主流程（所有写入都包在 try/catch 里）。
2. **零依赖**：用 Node 内置 `http` 手写 SSE，不引入 `ws` 之类的新依赖。
3. **仅控制台可用**：`/api/avatar/events` 明确拒绝带 `x-agent-call` / `x-agent-token`
   的请求，防止模型通过 MCP 工具读到控制台事件流。
4. **事件只增不改**：现有 `type` 的 `data` 字段只做**向后兼容的追加**。
   如果确实要破坏性修改，新增一个 `type` 而不是改旧的。
5. **不落盘**：事件不写文件、不持久化。需要历史就自己存。

---

## 五、以后要加什么（留给后续）

- `mood` / `emotion` 事件：让机器人主动上报情绪，形象据此切表情。
  需要先给机器人一个「设置当前表情」的工具（`qq_set_mood` 之类），再在桥接里转成事件。
- `typing` 事件：模型正在生成的中间态（现在只有 `turn.start` / `reply.out` 两端）。
- 双向：形象侧拖动/点击 → 影响机器人的注意力或唤醒（现在只能通过 `notify-ai` 绕）。
