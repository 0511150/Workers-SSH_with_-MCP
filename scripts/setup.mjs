import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
const terminal = createInterface({ input: stdin, output: stdout });
try {
  console.log('初始化仅需输入密钥长度。至少 10 位，推荐 32–128 位随机超长密码。');
  const answer = await terminal.question('密钥长度 [推荐 64]：');
  const length = Number(answer.trim() || 64);
  if (!Number.isInteger(length) || length < 10 || length > 4096) throw new Error('密钥长度必须是 10–4096 的整数。');
  const secret = randomBytes(Math.ceil(length * 3 / 4) + 1).toString('base64url').slice(0, length);
  // Exclusive create: never accidentally rotate an existing installation key.
  await writeFile('.dev.vars', `ACCESS_KEY=${secret}\n`, { flag: 'wx', mode: 0o600 });
  console.log('密钥已生成并保存到 .dev.vars（不加入 Git）。请用本地编辑器查看并保存到密码管理器。');
  console.log('npm run dev 启动本地服务；npm run deploy 自动上传该密钥并部署。');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { terminal.close(); }
