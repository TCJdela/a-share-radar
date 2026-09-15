# A股量价雷达认证后端

这是邀请制登录服务，不提供注册接口。超级账号在首次登录时由服务端环境变量初始化；普通账号只能由超级管理员创建。

## 部署前必须配置

1. 创建一个 Cloudflare D1 数据库并执行 `schema.sql`。
2. 将数据库 ID 写入 `wrangler.toml`。
3. 使用 Worker Secret 配置 `SUPER_PASSWORD`，不要把密码提交到 Git。
4. 部署 Worker 后，把公开地址写入根目录 `auth-config.js` 的 `AUTH_API_BASE`。

示例命令：

```bash
npx wrangler d1 create a-share-radar-auth
npx wrangler d1 execute a-share-radar-auth --remote --file=./schema.sql
npx wrangler secret put SUPER_PASSWORD
npx wrangler deploy
```

安全设计：PBKDF2-SHA256 210,000 次、随机盐、12 小时服务端会话、Bearer token 仅存 sessionStorage、登录失败限速、超级账号不可停用、无注册端点。普通账号默认密码由服务端变量提供，首次登录标记为需改密。
