/**
 * 环境适配。
 *
 * 在扩展里返回 'extension'；用 http 打开同一套页面时，装上一层
 * chrome.* 的模拟实现（dev/mock-api.js），方便不装载扩展也能看界面。
 * 生产路径完全不经过 mock。
 */

export async function ensureEnv() {
  if (location.protocol === 'chrome-extension:') return 'extension';
  const mock = await import('../dev/mock-api.js');
  await mock.install();
  return 'mock';
}
