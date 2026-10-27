# 本地定制说明（Fork Notes）

本仓库是 **[Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)** 的本地定制分支。

- 上游许可：**MIT**（见 `LICENSE`，版权归 Derpyu520 and qq-bridge / QSH contributors）
- 本分支版本基线：`v0.2.1-r1`（适配 DSH 0.2.1-rc.2）
- 本分支只做了下面列出的少量改动，其余与上游一致。

---

## 改动清单

### 1. `src/bridge.js` —— 主动机会提示词区分私聊 / 群聊

**问题**：`proactiveCheck` 唤醒的提示词写死为群聊语境（「群里已经安静了一段时间…结合记忆里的**群友**兴趣」）。
私聊会话被同样的提示词唤醒时，模型读到「群里 / 群友」，会误判场合、认为没有可接的话，从而**选择沉默**——
表现为「机器人从来不会主动私聊你」。

**改动**：按会话类型分支。私聊走一段专门文案，明确告知「这次不需要自然话题这个前提」「主动找他说话
本身就是正当的」，并建议发完用 `qq_set_wake_config` 设一个稍长的下次唤醒，避免刚说完又被立刻唤醒。

### 2. `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` —— 私聊例外条款

**问题**：预设里那句「不要频繁主动开话题，也不要硬抛；**没有自然话题就安静**」是写给群聊的，
在私聊场景与「主动找管理员说话」直接冲突。

**改动**：在该条后追加一条 `【私聊例外・重要】`，说明当会话是私聊管理员时该条不适用。

> ⚠️ 改完预设需要重新生成 bundle 并重启 DSH：
> `node scripts/setup-dsh.mjs web` → 重启 DSH → 重启桥接。

### 3. `roles/小鲸鱼.md` —— 追加「十一、私聊：跟管理员说话」

**问题**：原角色卡是「QQ 群友版」，全部围绕群聊展开，没有交代私聊里跟管理员怎么相处。

**改动**：追加一节，明确私聊对象是自己人、可以主动开口、别刷屏、发完不回就放下。

---

### 4. `src/mcp-bilibili.js` —— B站只读 MCP 服务器（新增）

给 agent 提供 6 个 **B站只读**工具：

| 工具 | 作用 |
| --- | --- |
| `bili_search_video` | 搜索视频 |
| `bili_video_info` | 视频详情（BV 号或链接 → 标题/UP/播放/点赞/分P/cid） |
| `bili_video_comments` | 读评论 |
| `bili_video_danmaku` | 读弹幕 |
| `bili_related` | 相关推荐 |
| `bili_hot` | 综合热门 / 排行榜 / 每周必看 / 热搜词 |

**全部走匿名接口**：不登录、不发帖、不评论、不点赞，不需要任何 Cookie 或账号凭据。

实测要点（2026-10-27）：

- 搜索**必须**走 `/x/web-interface/wbi/search/type` 路径并带 **WBI 签名**
  —— 旧路径 `/x/web-interface/search/type` 会被风控挡成 HTML。
- 用户信息、UP主投稿接口需要登录（`-352` 风控 / `412`），本服务器**不提供**。
- 弹幕走 `/x/v1/dm/list.so`（XML），直接解析 `<d p="...">文本</d>`。
- 请求显式绕过本机代理（B站是境内站点，直连更快、也更不容易被风控误判）。

**配套改动**：`plugins/qq-agent-presets/qq-tool-restrict.mjs` 的执行期白名单放行
`mcp__bilibili__` —— 不放行的话桥接会以「工具不在 QQ 桥接白名单内」拒绝调用（实测撞到过）。

**另需本机配置**（不在仓库内）：`~/.dsh/profiles/web/cordis.patch.yml` 里挂一个
`mcp-bilibili` 条目（`@deepseek-ai/dsh-mcp-client` + stdio + 本文件的绝对路径）。

**测试脚本**（新增）：

- `scripts/test-bilibili-mcp.mjs` —— stdio 直测：握手、列工具、真调工具
- `scripts/test-bili-dsh-tools.mjs` —— 验证 6 个工具确实进入 DSH 会话的工具面
- `scripts/test-bili-e2e.mjs` —— 端到端：建 qq-chat-v2 会话，让它真调 B站工具并取回真实数据

> 抖音：本分支**不做**。官方开放平台面向小程序/企业主体，个人没有做互动机器人的路径；
> 现实可行的只有只读解析视频，意义有限。

### 5. `src/mcp-bilibili.js` —— 登录只读工具（新增 7 个）

在上面 6 个匿名工具之外，再加 7 个**需要登录**的只读工具：

| 工具 | 作用 |
| --- | --- |
| `bili_me` | 当前登录账号信息（昵称/UID/等级/硬币/会员） |
| `bili_user_info` | UP主公开资料（粉丝数/投稿数/认证） |
| `bili_user_videos` | UP主投稿列表 |
| `bili_my_following` | 我的关注列表 |
| `bili_my_dynamics` | 首页动态流 |
| `bili_toview` | 稍后再看 |
| `bili_my_history` | 观看历史 |

凭据从 `config.json` 的 `bilibili` 段读（该文件被 `.gitignore` 排除，不会入库）：

```jsonc
{ "bilibili": { "sessdata": "你的 SESSDATA", "biliJct": "", "buvid3": "" } }
```

未配置时这些工具会返回可操作的提示，不会静默失败。**仍然全是只读**：
不发帖、不评论、不发弹幕、不点赞、不关注。

### 6. `AVATAR-API.md` + `src/bridge.js` 的虚拟形象事件流（新增）

给外部的「虚拟形象 UI」（Live2D / VRM / 网页形象）用的实时接口：

- **观察**：`GET /api/avatar/events`（SSE）广播 `hello` / `message.in` /
  `turn.start` / `reply.out` / `sticker.out` 五类事件，`reply.out` 带**分好条的**文本数组，
  适合逐条驱动口型与气泡。
- **控制**：沿用已有的 `POST /api/send/*`（以机器人身份直接发）与
  `POST /api/console/notify-ai`（塞进上下文，走完整人设与安全链路）。

完整字段说明与最小可用示例见 `AVATAR-API.md`。

> ⚠️ **实现注意**：事件总线放在**模块级**而不是 `main()` 里。消息入库（`message.in`）
> 与投递（`turn.start`）这两个事件点在 `main()` 之外，放在 `main()` 内会
> `ReferenceError: avatarEmit is not defined`（实测踩到并已修）。改这块时别把它挪回 `main()`。

## 未包含的文件（刻意排除）

| 文件 | 原因 |
| --- | --- |
| `config.json` | 含 OneBot accessToken、管理员 QQ 号等本机私密配置（上游 `.gitignore` 也已排除） |
| `state/` | 运行时数据：控制台令牌、会话 agentToken、聊天记录、用量账本 |
| `_snowluma-catalog.json` | 上游根目录中一份 SnowLuma 动作目录快照（190 条），**代码中无任何引用**。上游 `LICENSE` 明确写着「不要提交它的 catalog 快照，那本身就是再分发其内容」，故本分支不包含 |
| `node_modules/` | 依赖，`npm install` 即可重建 |

---

## 使用前提

本分支不改变上游的部署要求，仍需：

1. **DeepSeek Harness**（DSH）0.2.1-rc.2 运行在 `http://127.0.0.1:3080`
2. **SnowLuma** 运行并登录 QQ，开放 OneBot HTTP(3000) / WebSocket(3001)
3. **Node.js ≥ 22.13**

部署步骤见上游 `README.md` 的「完整启动流程」与 `docs/guides/DSH_SETUP.md`。

---

## 许可与合规

- 本仓库代码沿用上游 **MIT** 许可，版权声明见 `LICENSE`。
- 上游 `LICENSE` 中附有一段关于 **SnowLuma** 授权边界的说明（非许可证正文，但建议一并阅读）：
  SnowLuma 采用「源码可见非商业许可」，其 EULA §5.4 禁止未经书面授权把其专有组件并入第三方
  安装包、Docker 镜像或通过自动化脚本部署；§4(b) 对「基于本软件开发、发布或分发另一个项目」
  存在解释争议。**上游建议在公开发布前向 SnowLumaDevs 说明用途并询问是否需要额外条件。**
- 本分支同样**不含、不打包、不自动部署** SnowLuma 及其原生组件，仅通过 OneBot v11 协议与它通信。
