# x2.1 vs x2.1-flash 实时生成对比

本地测试用的小页面，和项目完全独立。左右两路同时生成：同一路输入画面、同一段提示词、同一张参考图，分别用 x2.1 和 x2.1-flash，方便直接比较画质、首帧耗时和帧率。

## 运行

```bash
npm install
npm run dev
```

浏览器会自动打开 http://localhost:5288 。

## 用 Docker 部署到 ad.xxx.com

纯静态页面，容器里只有一个 nginx。宿主机的反向代理负责域名和 HTTPS，转发到 `proxy_pass http://127.0.0.1:9399;`，容器绑定在本机 9399。

1. 本地构建：`npm run build`，生成 `dist/`。
2. 把这 4 样上传到服务器同一个目录（比如 `/opt/model-compare-demo/`）：
   `Dockerfile`、`docker-compose.yml`、`nginx.conf`、`dist/`
3. 9399 原来是 magicmirrorweb dev 分支（容器 `magicmirror-web-9399`）在用，先停掉它：
   ```bash
   docker ps --filter "publish=9399"
   docker stop magicmirror-web-9399 && docker rm magicmirror-web-9399
   ```
4. 在上传目录里构建并启动：
   ```bash
   docker compose up -d --build
   ```
5. 本机自测：`curl -I http://127.0.0.1:9399` 返回 200 后，打开 https://ad.xxx.com 。

以后更新：本地重新 `npm run build`，覆盖上传 `dist/`，再执行一次 `docker compose up -d --build`。

注意：

- 宿主机反代必须是 HTTPS，否则浏览器不允许打开摄像头（本地视频不受影响）。
- 不要把 API Key 写进代码；每个人在页面里填自己要用的 Key。
- 停用 demo：`docker compose down`。

## 使用

1. 填 Xmax API Key，选环境（china / global）。Key 只保存在本机浏览器里。
2. 「打开摄像头」或「选择本地视频」（视频会循环播放）。
3. 写提示词，参考图可选。
4. 点「开始对比」。生成中可以改提示词或参考图，再点「更新提示词 / 参考图」，不用重新连接。
5. 用完点「停止」。关闭页面也会自动断开。

## 说明

- 两边各建一路连接，**同时按两个模型计费**，测完记得停止。
- 每边按各自模型支持的尺寸送画面：x2.1 用 1920×1080 / 1080×1920 等，x2.1-flash 用 1280×704 / 704×1280 等。输入画面会等比铺满、居中裁剪到最接近的尺寸。
- 两边都关闭了自适应画质，按固定规格收发，便于对比。
- 面板下方显示：连接状态、首帧耗时、上行 / 输出分辨率、输出帧率和运行时长。
- 页面切到后台时浏览器会降低定时器频率，送出的画面帧率会下降，对比时请保持页面在前台。
