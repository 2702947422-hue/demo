# Nginx 只托管本地已构建好的 dist/（与 magicmirrorweb 的做法一致）：
#   1. 本地执行 npm run build，生成 dist/
#   2. 把 Dockerfile、docker-compose.yml、nginx.conf、dist/ 上传到服务器同一目录
# 服务器 docker build 只做 COPY，不需要安装 node。
FROM nginx:1.31.5
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY dist /usr/share/nginx/html
EXPOSE 80
