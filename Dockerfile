FROM node:24-alpine
#FROM node:lts-bookworm-slim

# 设置工作目录
WORKDIR /usr/src/claude_proxy

#ENV HAIKU_BASE_URL=https://openai.qiniu.com/v1
#ENV HAIKU_MODEL_NAME=gpt-oss-20b
#ENV HAIKU_API_KEY=sk-123456

RUN apt-get update && \
    apt-get install -y ca-certificates --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

RUN apt-get update && \
    apt-get install -y git --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*



# 克隆Git仓库（使用HTTP方式）
#RUN apk add --no-cache gcompat

#RUN apk add --no-cache git && \
#RUN git clone https://github.com/tingxifa/claude_proxy.git .
RUN git clone https://github.com/qidu/claude_express.git .

RUN pwd && ls -lh

# 或者使用SSH方式（需要提前配置SSH密钥）
# COPY id_rsa /root/.ssh/id_rsa
# RUN chmod 600 /root/.ssh/id_rsa && \
#     ssh-keyscan github.com >> /root/.ssh/known_hosts && \
#     git clone git@github.com:your-username/your-repo.git . && \
#     rm -rf /root/.ssh .git

# 安装项目依赖
RUN npm --no-color install express cors node-fetch \
 && echo "Install complete..." \
 && echo "node $(node --version)" \
 && echo "npm  v$(npm --version)"

# 执行命令
#RUN npm run build && \
#    npm test

# 暴露端口（如果需要）
EXPOSE 8787

# 设置启动命令（如果需要容器持续运行）
CMD ["node", "index.js"]
