/**
 * 消息协议版本。
 *
 * 背景：改了 background.js 之后，如果只在扩展页刷新（而不在 chrome://extensions
 * 点「重新加载」），页面是新的、service worker 还是旧的，两边消息表对不上，
 * sendMessage 会得到一个空回应。页面启动时用 ping 握手，对不上就明说。
 *
 * 改动 background 的消息表时，把这个数字 +1。
 */
export const PROTO = 3;
