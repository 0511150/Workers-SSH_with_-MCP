const form = document.querySelector('#login-form');
const input = document.querySelector('#key');
const message = document.querySelector('#message');
const submit = document.querySelector('#submit');
document.querySelector('#show-key').addEventListener('click', event => {
  input.type = input.type === 'password' ? 'text' : 'password';
  event.currentTarget.textContent = input.type === 'password' ? '显示' : '隐藏';
  event.currentTarget.setAttribute('aria-label', input.type === 'password' ? '显示密钥' : '隐藏密钥');
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (Array.from(input.value).length < 10) { message.textContent = '密钥至少需要 10 位。'; return; }
  submit.disabled = true;
  message.textContent = '正在验证…';
  try {
    const response = await fetch('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: input.value }) });
    const result = await response.json();
    if (response.ok) { input.value = ''; location.replace('/'); return; }
    message.textContent = result.error || '验证失败，请重试。';
  } catch { message.textContent = '连接失败，请检查网络后重试。'; }
  finally { submit.disabled = false; }
});
