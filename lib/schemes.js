/**
 * 预置的整理方案（分类法）。
 *
 * 每个方案是一组「编码 + 名字 + 给模型看的语义说明」。
 * 编码形态只有两种：
 *   数字（digit）：1–3 位，解析时补零到三位，例如 0 → 000、12 → 012
 *   字母（letter）：1–3 位，解析时转大写，例如 t → T、TP → TP
 *
 * 重要约束：字母编码必须由「已安装的方案」驱动，不能靠正则见到就认。
 * 否则「B 站」「AI 工具」这种普通文件夹会被误判成类目。
 * 调用方请用 parseOptsOf(id) 拿到 { letterSet, order, hintMap } 传给 parseTree。
 *
 * 另一个已知冲突：所有数字方案的编码都在 000–900 这个空间里，
 * 同时安装两套（例如杜威 + PARA）会出现同号不同名。安装阶段必须做冲突预检。
 */

/** 数字方案的默认说明（沿用 0.4.x 的原文，别改，否则解析基线会变） */
export const DEWEY_HINTS = {
  '000': '通用、效率、工具箱、引擎入口',
  '100': '编程语言、后端服务、框架、面试',
  '200': '数据库、消息队列、搜索、数据工程',
  '300': '网络协议、代理、路由设备、抓包',
  '400': '操作系统、内核、容器、部署运维',
  '500': '模型、论文、智能体、提示工程',
  '600': 'Web、前端框架、CSS、构建工具',
  '700': '图书、论文、课程、方法论',
  '800': '资讯、社区、论坛、周刊',
  '900': '影音、游戏、生活、娱乐',
};

const DEWEY_FOLDERS = [
  { code: '000', name: '综合与工具' },
  { code: '100', name: '编程与后端' },
  { code: '200', name: '数据与中间件' },
  { code: '300', name: '网络与通信' },
  { code: '400', name: '系统与运维' },
  { code: '500', name: '人工智能' },
  { code: '600', name: 'Web 与前端' },
  { code: '700', name: '学习与文献' },
  { code: '800', name: '资讯与社区' },
  { code: '900', name: '娱乐与生活' },
].map((f) => ({ ...f, hint: DEWEY_HINTS[f.code] }));

export const SCHEMES = [
  {
    id: 'dewey',
    name: '杜威十进',
    kind: 'digit',
    desc: '十类，编码 000–900，与现有目录规则完全一致；已有这套目录时零迁移。',
    folders: DEWEY_FOLDERS,
  },
  {
    id: 'lite5',
    name: '精简五类',
    kind: 'digit',
    desc: '只分五类，适合不想记十个编号的人。',
    folders: [
      { code: '100', name: '工作', hint: '公司项目、内网系统、协作与文档' },
      { code: '200', name: '学习', hint: '课程教程、文档手册、论文与方法论' },
      { code: '300', name: '工具', hint: '效率软件、在线服务、开发工具、素材站' },
      { code: '400', name: '资讯', hint: '新闻、博客、社区、周刊、行业动态' },
      { code: '500', name: '生活', hint: '影音游戏、购物旅行、健康与日常' },
    ],
  },
  {
    id: 'para',
    name: 'PARA',
    kind: 'digit',
    desc: '项目 / 领域 / 资源 / 归档，按“现在要用还是长期留存”切分。',
    folders: [
      { code: '100', name: '项目', hint: '有明确目标和截止时间的在办事项' },
      { code: '200', name: '领域', hint: '需要长期跟踪的职责与兴趣方向' },
      { code: '300', name: '资源', hint: '可复用的参考、素材、工具与书签' },
      { code: '400', name: '归档', hint: '已完成或不再活跃，但值得留档' },
    ],
  },
  {
    id: 'clc12',
    name: '中图法（精简 12 类）',
    kind: 'letter',
    desc: '取《中图法》里对网页收藏有意义的 12 个顶级类，字母编码。',
    folders: [
      { code: 'B', name: '哲学与宗教', hint: '思想流派、伦理、宗教、心理学与认知' },
      { code: 'C', name: '社会科学', hint: '社会学、人口、统计、组织与管理理论' },
      { code: 'D', name: '政治与法律', hint: '政策法规、政府站点、合规、合同与法务' },
      { code: 'F', name: '经济与商业', hint: '财经资讯、公司研究、创业投资、行业报告' },
      { code: 'G', name: '教育与文化', hint: '课程教程、考试、图书馆博物馆、工具书' },
      { code: 'H', name: '语言与文字', hint: '外语学习、翻译、写作规范、字词与辞书' },
      { code: 'I', name: '文学', hint: '小说散文诗歌、书评、作家与作品资料' },
      { code: 'J', name: '艺术', hint: '音乐美术、设计摄影、影视与创作' },
      { code: 'K', name: '历史与地理', hint: '历史事件、人物传记、地方志、地理旅行' },
      { code: 'N', name: '自然科学', hint: '数理化生、天文地理、科普与科研工具' },
      { code: 'T', name: '工业技术', hint: '计算机、编程、算法、AI、网络、硬件、工程' },
      { code: 'Z', name: '综合与工具', hint: '工具箱、搜索聚合、效率软件、无明确归属' },
    ],
  },
  {
    id: 'clc22',
    name: '中图法（完整 22 类）',
    kind: 'letter',
    desc: '《中图法》22 个基本大类原样保留；书签栏会比较长。',
    folders: [
      { code: 'A', name: '马克思主义、列宁主义、毛泽东思想、邓小平理论', hint: '经典理论与党的文献' },
      { code: 'B', name: '哲学、宗教', hint: '思想流派、伦理、宗教、心理学与认知' },
      { code: 'C', name: '社会科学总论', hint: '社会学、人口、统计、组织与管理理论' },
      { code: 'D', name: '政治、法律', hint: '政策法规、政府站点、合规、合同与法务' },
      { code: 'E', name: '军事', hint: '军事理论、战史、装备与国防' },
      { code: 'F', name: '经济', hint: '财经资讯、公司研究、创业投资、行业报告' },
      { code: 'G', name: '文化、科学、教育、体育', hint: '课程教程、考试、图书馆博物馆、体育运动、工具书' },
      { code: 'H', name: '语言、文字', hint: '外语学习、翻译、写作规范、字词与辞书' },
      { code: 'I', name: '文学', hint: '小说散文诗歌、书评、作家与作品资料' },
      { code: 'J', name: '艺术', hint: '音乐美术、设计摄影、影视与创作' },
      { code: 'K', name: '历史、地理', hint: '历史事件、人物传记、地方志、地理旅行' },
      { code: 'N', name: '自然科学总论', hint: '科学史、科学方法、科普与综合科技' },
      { code: 'O', name: '数理科学和化学', hint: '数学、力学、物理、化学' },
      { code: 'P', name: '天文学、地球科学', hint: '天文、地质、气象、海洋与测绘' },
      { code: 'Q', name: '生物科学', hint: '生物、生态、遗传与生命科学' },
      { code: 'R', name: '医药、卫生', hint: '医学、药学、保健与公共卫生' },
      { code: 'S', name: '农业科学', hint: '农学、林业、畜牧、水产' },
      { code: 'T', name: '工业技术', hint: '计算机、编程、算法、AI、网络、硬件、自动化与工程' },
      { code: 'U', name: '交通运输', hint: '铁路公路、水路、航空运输与车辆工程' },
      { code: 'V', name: '航空、航天', hint: '飞行器、航天工程与探索' },
      { code: 'X', name: '环境科学、安全科学', hint: '环境保护、污染治理、安全生产与灾害' },
      { code: 'Z', name: '综合性图书', hint: '丛书、百科全书、年鉴、目录索引' },
    ],
  },
];

export const DEFAULT_SCHEME_ID = 'dewey';

export function getScheme(id) {
  return SCHEMES.find((s) => s.id === id) || null;
}

export function listSchemes() {
  return SCHEMES.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    desc: s.desc,
    codes: s.folders.map((f) => f.code),
  }));
}

/** 字母方案 → 允许的编码集合；数字方案返回 null（表示不启用字母识别） */
export function letterSetOf(scheme) {
  if (!scheme || scheme.kind !== 'letter') return null;
  return new Set(scheme.folders.map((f) => f.code));
}

/** 方案定义的顺序，parseTree 用它排 scheme，避免字母编码被 localeCompare 打乱 */
export function orderOf(scheme) {
  return scheme ? scheme.folders.map((f) => f.code) : null;
}

/** code → 说明，喂给模型的语义提示 */
export function hintMapOf(scheme) {
  if (!scheme) return null;
  return scheme.folders.reduce((acc, f) => {
    if (f.hint) acc[f.code] = f.hint;
    return acc;
  }, {});
}

/**
 * 一步到位拿到 parseTree 需要的 opts。
 * 没装方案（id 为空或不存在）时返回 {}，解析行为与 0.4.x 完全一致。
 */
export function parseOptsOf(id) {
  const scheme = getScheme(id);
  if (!scheme) return {};
  return {
    letterSet: letterSetOf(scheme),
    order: orderOf(scheme),
    hintMap: hintMapOf(scheme),
  };
}
