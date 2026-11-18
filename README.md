# dsh-tts

DeepSeek Harness 朗读插件（TTS）：给每条助手回复加一个小喇叭，接入任意 **OpenAI 兼容** 的 `/audio/speech` 端点朗读正文。

![badge](https://img.shields.io/badge/dsh-plugin-blue)

## 功能

| 位置 | 功能 |
| --- | --- |
| 每条助手回复的操作行 | 🔊 小喇叭：朗读本条回复正文（朗读中变停止方块，再点停止）；非当前会话置灰不读 |
| 输入框右下角 | 自动朗读开关：**喇叭+声波（蓝）= 播放态**，新回复生成后自动朗读；**喇叭+斜杠（灰）= 静默态**，只手动朗读 |
| 会话头部工具区 | 「朗读」芯片：设置面板（接口地址 / API Key / 模型 / 音色 / 语速 / 格式 / 自动朗读范围），试听一句、停止播放 |

细节：

- 长回复按句子边界切成 ~1200 字的块，边合成边播（有一个预取在飞），不卡流式输出；
- 正文提取剔除代码块，只读叙述文字；自动朗读范围可选「只读末尾总结段落」（默认）或「全文」；
- **会话感知**：同一页面开多个会话（分栏/新标签页）时，只读当前选中的会话，后台会话不朗读；
- 芯片显示当前正在朗读的会话名，旁边有立刻停止的按钮；
- 配置持久化在宿主侧 `~/.dsh/tts-config.json`，**所有窗口（桌面壳 / 浏览器 / 手机）共享一份**，新窗口不用重填。

## 安装

### 方式一：脚本（推荐）

**Windows（PowerShell）：**

```powershell
git clone https://github.com/cuteG41cute/dsh-tts.git
cd dsh-tts
powershell -ExecutionPolicy Bypass -File install.ps1
```

**Linux（bash）：**

```bash
git clone https://github.com/cuteG41cute/dsh-tts.git
cd dsh-tts
bash install.sh
```

脚本做两件事：把包复制到 `~/.dsh/profiles/web/node_modules/dsh-tts`，并在 `~/.dsh/profiles/web/cordis.patch.yml` 追加（幂等，重复运行不会写重）：

```yaml
# ── installed-by: dsh-tts ──
- insert:
    - id: dsh-tts
      name: 'dsh-tts'
```

装完**重启一次 harness**（宿主半部要随启动加载）。

### 方式二：手动

1. 复制整个包目录（`package.json` + `lib/`）到 `~/.dsh/profiles/web/node_modules/dsh-tts/`；
2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 追加上面那段 YAML；
3. 重启 harness。

## 配置

装好重启后，点会话头部「朗读」芯片：

| 字段 | 说明 |
| --- | --- |
| 接口地址 | OpenAI 兼容 base，如 `https://api.example.com/v1` 或本地 `http://127.0.0.1:8092/v1`（自动补 `/audio/speech`） |
| API Key | 留空则不发送 Authorization；填了则 `Bearer` 头 |
| 模型 / 音色 / 语速 / 格式 | 按你的 TTS 服务要求填（`tts-1` / `alloy` / `1` / `mp3` 是常见默认） |

填完点「保存」，所有窗口共享。**注意：API Key 会明文存在 `~/.dsh/tts-config.json`**（本机用户目录），介意的话可自行加密或改代码只落盘非密钥字段。

## 已验证的后端

- [codec.cpp `tts-server`](https://github.com/mybigday/codec.cpp)（Qwen3-TTS GGUF，本地离线）
- [audio.cpp `audiocpp_server`](https://github.com/audio-cpp/audio.cpp)（Kokoro / Qwen3-TTS 等，本地离线）
- 任意 OpenAI 兼容云端 TTS（`/v1/audio/speech` 形状一致即可）

## 已知限制

- 语速是否生效取决于后端（有的服务只接受 1.0）；
- 路径 / URL 会被 TTS 逐字符朗读，代码块已剔除，行内代码会读出；
- 音频合成经宿主中转（浏览器直连第三方端点会被 CORS 拦）。

## License

MIT
