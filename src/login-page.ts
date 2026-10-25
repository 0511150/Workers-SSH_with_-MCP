import { secureResponse } from './http-security';
export function loginPage(): Response {
  return secureResponse(new Response(`<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><meta name="darkreader-lock"><meta name="theme-color" content="#f5f3ed"><title>访问验证 · Workers SSH</title><link rel="stylesheet" href="/login.css"><script src="/login.js" defer></script></head>
<body><header><a href="/">Workers SSH<span>PERSONAL WORKSPACE</span></a></header>
<main>
<section class="card"><div class="lock">⌘</div><div class="eyebrow">PRIVATE ACCESS</div><h2>你的终端，只为你打开。</h2><p>输入访问密钥，进入私人 SSH 工作台。</p><form id="login-form"><label for="key">访问密钥</label><div class="input-wrap"><input id="key" name="key" type="password" autocomplete="current-password" placeholder="请输入至少 10 位的访问密钥" required minlength="10" maxlength="4096"><button id="show-key" type="button" aria-label="显示密钥">显示</button></div><button id="submit" type="submit">解锁工作台 <span>→</span></button><p id="message" role="status" aria-live="polite"></p></form><div class="note">私人访问保护 · 多次输错将逐级封禁 IP，最高永久封禁</div><div class="recommend">推荐使用 32 位以上随机超长密码。MCP 客户端使用相同密钥。</div></section></main>
<footer><span>让每一次连接，都安心有序。</span><span>Cloudflare Workers · SSH · MCP</span></footer></body></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }));
}
