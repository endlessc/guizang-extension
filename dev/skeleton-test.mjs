#!/usr/bin/env node
/**
 * 骨架解析的断言：模型回复千奇百怪，这里锁住「什么算合法、脏数据怎么处理」。
 * 真实模型的输出质量测不了（要 Key），但解析契约可以。
 *
 * 用法：node dev/skeleton-test.mjs
 */

import { parseSkeleton } from '../lib/llm.js';

let failed = 0;
function eq(label, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) console.log(`  ✓ ${label}`);
  else {
    failed += 1;
    console.error(`  ✗ ${label}\n      实际：${a}\n      期望：${b}`);
  }
}
function throws(label, fn, keyword) {
  try { fn(); eq(label, '没抛错', '应当抛错'); }
  catch (e) { eq(label, String(e.message).includes(keyword), true); }
}

const ok = '{"categories":[{"name":"开发工具","hint":"IDE 与命令行","children":[{"name":"编辑器","hint":"VS Code"}]},{"name":"资讯","hint":"新闻社区"}]}';

console.log('正常输出');
{
  const s = parseSkeleton(ok);
  eq('顶层两个', s.map((c) => c.name), ['开发工具', '资讯']);
  eq('子类保留', s[0].children.map((c) => c.name), ['编辑器']);
  eq('hint 保留', s[0].hint, 'IDE 与命令行');
}

console.log('容忍脏外壳');
{
  eq('```json 围栏', parseSkeleton('```json\n' + ok + '\n```').length, 2);
  eq('前后有解释文字', parseSkeleton('好的，结果如下：\n' + ok + '\n以上。').length, 2);
  eq('多余空白与换行', parseSkeleton('\n\n  ' + ok + '  \n').length, 2);
}

console.log('截断与过滤');
{
  const many = JSON.stringify({ categories: Array.from({ length: 15 }, (_, i) => ({ name: '类' + i, children: Array.from({ length: 9 }, (_, j) => ({ name: '子' + j })) })) });
  const s = parseSkeleton(many, { maxTop: 10, maxPerTop: 4 });
  eq('顶层封顶', s.length, 10);
  eq('子类封顶', s[0].children.length, 4);

  const long = JSON.stringify({ categories: [{ name: '这是一个非常非常非常长的类目名字超过十二个字', hint: 'h'.repeat(80) }] });
  const s2 = parseSkeleton(long);
  eq('名字截到 12 字', s2[0].name.length, 12);
  eq('hint 截到 40 字', s2[0].hint.length, 40);

  const dirty = JSON.stringify({ categories: [null, 42, { name: '' }, { name: '有效' }, { name: '有子', children: [null, { name: '' }, { name: '真子' }] }] });
  eq('空/非对象项被过滤', parseSkeleton(dirty).map((c) => c.name), ['有效', '有子']);
  eq('子类同样过滤', parseSkeleton(dirty)[1].children.map((c) => c.name), ['真子']);
}

console.log('该报错就报错');
{
  throws('不是 JSON', () => parseSkeleton('抱歉，我无法完成'), '没有返回可解析');
  throws('缺 categories', () => parseSkeleton('{"items":[]}'), '没有返回可解析');
  throws('categories 不是数组', () => parseSkeleton('{"categories":"x"}'), '没有返回可解析');
  throws('空数组', () => parseSkeleton('{"categories":[]}'), '空的');
  throws('全是无效项', () => parseSkeleton('{"categories":[null,{"name":""}]}'), '空的');
  throws('空字符串', () => parseSkeleton(''), '没有返回可解析');
  throws('超长无关文本', () => parseSkeleton('x'.repeat(5000)), '没有返回可解析');
}

if (failed) {
  console.error(`\n❌ ${failed} 项断言失败`);
  process.exit(1);
}
console.log('\n✅ 全部通过');
