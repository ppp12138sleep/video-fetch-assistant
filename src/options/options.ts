import { SUPPORTED_PAGE_PATTERNS, TEST_PAGE_PATTERNS } from '../shared/constants';

const ORIGINS = ['http://*/*', 'https://*/*'];
const SCRIPT_IDS = ['vva-generic-hook', 'vva-generic-content'];
const EXCLUDED = [...SUPPORTED_PAGE_PATTERNS, ...TEST_PAGE_PATTERNS];

const toggle = document.getElementById('toggle-generic') as HTMLButtonElement;
const stateBadge = document.getElementById('permission-state') as HTMLSpanElement;
const message = document.getElementById('permission-message') as HTMLParagraphElement;
const testButton = document.getElementById('open-test') as HTMLButtonElement;

let enabled = false;
let working = false;

void init();

async function init(): Promise<void> {
  try {
    enabled = await chrome.permissions.contains({ origins: ORIGINS });
    if (enabled) await ensureRegistered();
    render();
  } catch (error) {
    setStatus(`读取权限失败：${errorText(error)}`, 'error');
    toggle.disabled = false;
    toggle.textContent = '重试';
  }
}

function render(): void {
  toggle.disabled = false;
  toggle.textContent = enabled ? '关闭通用网站自动支持' : '启用通用网站自动支持';
  stateBadge.textContent = enabled ? '已启用' : '未启用';
  stateBadge.className = `badge ${enabled ? 'badge--on' : 'badge--off'}`;
  if (!message.textContent) {
    setStatus(
      enabled
        ? '已授权 http/https 全站匹配。刷新目标网页后生效；可随时关闭。'
        : '未授权全站匹配。可通过工具栏图标临时注入当前页。',
      'success',
    );
  }
}

async function ensureRegistered(): Promise<void> {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: SCRIPT_IDS });
  if (existing.length) {
    await chrome.scripting.unregisterContentScripts({ ids: SCRIPT_IDS });
  }
  await chrome.scripting.registerContentScripts([
    {
      id: 'vva-generic-hook',
      matches: ORIGINS,
      excludeMatches: EXCLUDED,
      js: ['network-hook.js'],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: false,
      persistAcrossSessions: true,
    },
    {
      id: 'vva-generic-content',
      matches: ORIGINS,
      excludeMatches: EXCLUDED,
      js: ['content-script.js'],
      runAt: 'document_idle',
      world: 'ISOLATED',
      allFrames: false,
      persistAcrossSessions: true,
    },
  ]);
}

toggle.addEventListener('click', () => {
  if (working) return;
  void togglePermission();
});

testButton.addEventListener('click', () => {
  void chrome.tabs.create({ url: 'http://127.0.0.1:4173', active: true });
});

async function togglePermission(): Promise<void> {
  working = true;
  toggle.disabled = true;
  toggle.textContent = '等待浏览器确认…';
  setStatus('', 'neutral');
  try {
    if (enabled) {
      await chrome.scripting.unregisterContentScripts({ ids: SCRIPT_IDS }).catch(() => undefined);
      await chrome.permissions.remove({ origins: ORIGINS });
      enabled = false;
      setStatus('已关闭通用网站支持，并移除动态内容脚本。已打开的网页刷新后不再注入。', 'success');
    } else {
      const granted = await chrome.permissions.request({ origins: ORIGINS });
      if (!granted) {
        setStatus('未获得全站访问权限，通用网站自动支持保持关闭。你仍可通过工具栏图标按页启用。', 'error');
        enabled = false;
      } else {
        await ensureRegistered();
        enabled = true;
        setStatus('已开启通用网站支持。请刷新目标网页，按钮只会出现在检测到视频的页面。', 'success');
      }
    }
  } catch (error) {
    setStatus(`操作失败：${errorText(error)}`, 'error');
    enabled = await chrome.permissions.contains({ origins: ORIGINS }).catch(() => enabled);
  } finally {
    working = false;
    render();
  }
}

function setStatus(text: string, kind: 'success' | 'error' | 'neutral'): void {
  message.textContent = text;
  message.dataset.kind = kind;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
