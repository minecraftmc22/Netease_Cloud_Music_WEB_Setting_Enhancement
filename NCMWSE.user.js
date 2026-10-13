// ==UserScript==
// @name         网易云音乐设置增强(NCMWSE)
// @name:en      Netease Cloud Music WEB Setting Enhancement
// @namespace    https://github.com/minecraftmc22/Netease_Cloud_Music_WEB_Setting_Enhancement
// @version      1.3.8
// @description  检测网易云音乐网页版正在播放的歌曲，把歌曲信息同步到系统媒体控制（SMTC）。设置面板采用选项卡布局：SMTC 的标题栏/歌手栏/专辑栏与网页标题栏均为可拖拽排序的片段模块（歌曲名/歌手/歌词/翻译/专辑/网站名称/连接符），连接符本身也是可拖拽、可改文本的片段，带快速预设、歌词延迟调节（自动校准/手动偏移）、歌词时间戳配对、配置导入导出与诊断信息
// @description:en  Detect the song playing on Netease Cloud Music web player, sync "song / artist" or "current lyric / song-artist" to Windows SMTC, and customize the page title with drag-and-drop segments. Separators are draggable segments too.
// @author       Minecraftmc22
// @license      MIT
// @icon         https://s1.music.126.net/style/favicon.ico
// @match        *://music.163.com/*
// @match        *://*.music.163.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* =========================================================================
   * 网易云音乐设置增强 (NCMWSE)
   * Netease Cloud Music WEB Setting Enhancement
   * -------------------------------------------------------------------------
   * 原理：读取网易云网页版(含同源 iframe)的播放信息 + 歌词 API，
   *       写入 Media Session API，Windows 会把它同步到「系统媒体控制」
   *       （Win+G / 音量键 / 锁屏显示的媒体卡片）。
   *
   * 1) 系统媒体（SMTC）：三个可自由编排的栏位 —— 标题栏 / 歌手栏 / 专辑栏，
   *      每栏都是一份「片段列表」（歌曲名 / 歌手 / 歌词 / 翻译 / 专辑 / 网站名称 / 连接符），
   *      可拖拽排序、增删；
   *      内置预设：歌曲名/歌手、歌词/歌曲名 - 歌手、歌词 翻译/歌曲名 - 歌手。
   * 2) 网页标题：同样的片段列表，可拖拽排序，
   *      内置预设：歌曲名 - 歌手 - 网站名称 / 歌词 翻译 - 歌曲名 - 歌手 / 歌词 翻译。
   * 3) 「翻译」本身就是一个片段：把它排进片段列表即可显示当前歌词的译文，
   *      位置随意（歌词 - 翻译、翻译 - 歌词、单独一栏都行）；
   *      本句没有译文时该片段为空并自动跳过，不会沿用上一句。
   * 4) 「连接符」也是一个片段：在「添加片段」里选「连接符」，
   *      拖动它到需要加分隔的位置，文本可改（一栏里能放多个、各不相同）；
   *      它只在前面已经出现过内容片段时才生效，所以放在开头/结尾不会多出符号。
   * 5) 配置可导出为 JSON（复制或下载），也能从粘贴内容 / 文件导入。
   * 6) 歌词同步：歌词比声音慢/快时可以调偏移 ——
   *      「自动」把行切换精确排期到时间戳那一刻（消掉主循环 300ms 间隔的延迟），
   *        并在能读到页面歌词时以页面歌词为基准自动微调；
   *      「手动」用滑杆加减偏移量，用来抵消系统媒体卡片那侧的渲染延迟。
   *
   * 设置面板：左侧选项卡（常规 / 歌词同步 / 系统媒体 / 网页标题 / 诊断信息）切换，
   *      每个版块一页；切换时指示块滑动 + 页面淡入上移，套用预设时片段逐行滑入。
   * ========================================================================= */

  const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  if (W.top !== W.self) return; // 只在顶层文档运行

  /* ============================ 配置 ============================ */

  const CFG_KEY = 'ncm_smtc_cfg';
  const VER = '1.3.8';

  // 可用的片段类型（「翻译」与「连接符」都是片段：放在哪、和谁拼，全由片段顺序决定）
  const PART_META = {
    song: { name: '歌曲名', hasText: false },
    artist: { name: '歌手', hasText: false },
    lyric: { name: '歌词', hasText: false },
    trans: { name: '翻译', hasText: false },
    album: { name: '专辑', hasText: false },
    site: { name: '网站名称', hasText: true, def: '网易云音乐' },
    sep: { name: '连接符', hasText: true, def: ' - ', isSep: true }
  };
  const PART_ORDER = ['song', 'artist', 'lyric', 'trans', 'album', 'site', 'sep'];
  const SEP_DEF = ' - ';

  function defPart(type) {
    const m = PART_META[type];
    return { type: type, text: (m && m.hasText) ? (m.def || '') : '' };
  }

  // 连接符片段：文本就是它在两段内容之间补上的字符
  function sepPart(text) {
    return { type: 'sep', text: (typeof text === 'string') ? text : SEP_DEF };
  }

  /* 歌词偏移的可调范围（秒）：一般不会超过 1 秒，留到 3 秒足够应付各种场景 */
  const OFF_MAX = 3;

  function clampOffset(v) {
    let n = Number(v);
    if (!isFinite(n)) n = 0;
    if (n > OFF_MAX) n = OFF_MAX;
    if (n < -OFF_MAX) n = -OFF_MAX;
    // 保留两位小数，避免滑杆浮点误差写进配置
    return Math.round(n * 100) / 100;
  }

  // 四个可编辑的「片段模块」：SMTC 的标题栏/歌手栏/专辑栏 + 网页标题栏
  const DEF_CFG = {
    enabled: true,
    showFab: true,            // 页面右下角显示设置按钮
    showArtwork: true,        // 显示专辑封面
    sepV2: true,              // v1.3.8：连接符已改成片段，旧配置迁移标记
    lyric: {
      sync: 'auto',           // 'auto' | 'manual' —— 歌词延迟调节方式
      offset: 0               // 手动偏移（秒）：正 = 歌词提前显示，负 = 延后
    },
    smtc: {
      title: [defPart('song')],
      artist: [defPart('artist')],
      album: [defPart('album')]
    },
    titleCfg: {                // 网页标题
      enabled: false,
      parts: [defPart('song'), sepPart(), defPart('artist'), sepPart(), defPart('site')]
    }
  };

  /* 预设：SMTC 三组、网页标题三组；是否带译文、用什么分隔，都由片段列表自己描述 */
  const SMTC_PRESETS = [
    { name: '歌曲名 / 歌手', title: ['song'], artist: ['artist'], album: ['album'] },
    { name: '歌词 / 歌曲名 - 歌手', title: ['lyric'], artist: ['song', 'sep', 'artist'], album: ['album'] },
    { name: '歌词 翻译 / 歌曲名 - 歌手', title: ['lyric', 'sep', 'trans'], artist: ['song', 'sep', 'artist'], album: ['album'] }
  ];

  const TITLE_PRESETS = [
    { name: '歌曲名 - 歌手 - 网站名称', parts: ['song', 'sep', 'artist', 'sep', 'site'] },
    { name: '歌词 翻译 - 歌曲名 - 歌手', parts: ['lyric', 'sep', 'trans', 'sep', 'song', 'sep', 'artist'] },
    { name: '歌词 翻译', parts: ['lyric', 'sep', 'trans'] }
  ];

  let cfg = readCfg();

  function defParts() {
    return DEF_CFG.titleCfg.parts.map(function (p) { return { type: p.type, text: p.text || '' }; });
  }

  function cloneParts(arr) {
    return (Array.isArray(arr) ? arr : []).map(function (p) {
      return {
        type: (p && p.type) || '',
        text: (p && typeof p.text === 'string') ? p.text : ''
      };
    });
  }

  /* 旧版配置迁移：v1.3.3 及之前是 line1/line2 两个下拉框，
     现在改成一栏一份的片段列表，这里把旧选择翻译成片段 */
  function migrateCfg(src) {
    const s = src || {};
    if (s.smtc || (!('line1' in s) && !('line2' in s))) return s;
    const o = Object.assign({}, s);
    o.smtc = {
      sep: ' - ',
      title: (s.line1 === 'lyric') ? [defPart('lyric')] : [defPart('song')],
      artist: [],
      album: [defPart('album')]
    };
    switch (s.line2) {
      case 'artist': o.smtc.artist = [defPart('artist')]; break;
      case 'song-artist': o.smtc.artist = [defPart('song'), defPart('artist')]; break;
      case 'song': o.smtc.artist = [defPart('song')]; break;
      case 'album': o.smtc.artist = [defPart('album')]; break;
      case 'none': o.smtc.artist = []; break;
      default: o.smtc.artist = [defPart('artist')];
    }
    delete o.line1;
    delete o.line2;
    return o;
  }

  // 深拷贝配置（parts / smtc 里都是数组，浅拷贝会被 draft 编辑污染）
  function cloneCfg(c) {
    const src = migrateCfg(c);
    const o = Object.assign({}, DEF_CFG, src);
    o.lyric = Object.assign({}, DEF_CFG.lyric, src.lyric || {});
    const sm = Object.assign({}, DEF_CFG.smtc, src.smtc || {});
    sm.title = cloneParts(sm.title);
    sm.artist = cloneParts(sm.artist);
    sm.album = cloneParts(sm.album);
    o.smtc = sm;
    const tc = Object.assign({}, DEF_CFG.titleCfg, src.titleCfg || {});
    tc.parts = cloneParts(tc.parts);
    o.titleCfg = tc;
    return o;
  }

  /* v1.3.5 迁移：旧的「启用翻译?」布尔开关 → 片段列表里的「翻译」片段。
     旧版译文是紧跟在「歌词」片段后面的，所以只在含歌词片段的那一栏插入「翻译」，
     插在该栏最后一个「歌词」片段之后；该栏没有歌词片段则不动（旧版那样也看不到译文）。
     v1.3.8 起「歌词」后面可能紧跟一个（或几个）连接符片段 —— 译文要落到连接符之后，
     才能还原旧版的「歌词 - 译文」而不吃掉分隔符 */
  function migrateTransFlag(list, flag) {
    const arr = Array.isArray(list) ? list : [];
    if (!flag) return arr;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].type === 'trans') return arr;   // 已有翻译片段，不重复插
    }
    let at = -1;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].type === 'lyric') at = i;
    }
    if (at < 0) return arr;
    let ins = at + 1;
    while (ins < arr.length && arr[ins] && arr[ins].type === 'sep') ins++;
    arr.splice(ins, 0, defPart('trans'));
    return arr;
  }

  /* v1.3.8 迁移：旧配置里连接符是全局独立字段（smtc.sep / titleCfg.sep）。
     现在连接符是片段，这里把它按原样插进各片段之间，升级后观感与旧版一致；
     末尾也补一个，以后往末尾添加片段时正好夹在两者中间。
     已迁移过的配置（sepV2）不再处理，所以用户主动删掉所有连接符也能保持住 */
  function injectSep(list, sepText) {
    const arr = (Array.isArray(list) ? list : []).slice();
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].type === 'sep') return arr;   // 已是新结构
    }
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      out.push(arr[i]);
      if (i < arr.length - 1 || arr.length <= 1) out.push(sepPart(sepText));
    }
    return out;
  }

  function oldSep(src, key) {
    const box = src && src[key];
    return (box && typeof box.sep === 'string') ? box.sep : SEP_DEF;
  }

  // 读取时做一次合法性校验
  function normalizeCfg(c) {
    const raw = migrateCfg(c);
    const needSep = !(raw && raw.sepV2);            // 老配置：连接符还是独立字段
    const smtcSep = oldSep(raw, 'smtc');
    const titleSep = oldSep(raw, 'titleCfg');
    const o = cloneCfg(raw);
    const okPart = function (p) { return p.type && PART_META[p.type]; };
    o.smtc.title = o.smtc.title.filter(okPart);
    o.smtc.artist = o.smtc.artist.filter(okPart);
    o.smtc.album = o.smtc.album.filter(okPart);
    o.titleCfg.parts = o.titleCfg.parts.filter(okPart);
    if (!o.titleCfg.parts.length) o.titleCfg.parts = defParts();
    // SMTC 三栏全空时给个兜底，免得媒体卡片全空
    if (!o.smtc.title.length && !o.smtc.artist.length && !o.smtc.album.length) {
      o.smtc.title = [defPart('song')];
      o.smtc.artist = [defPart('artist')];
    }
    // 旧版的全局连接符 → 逐段插入「连接符」片段
    if (needSep) {
      o.smtc.title = injectSep(o.smtc.title, smtcSep);
      o.smtc.artist = injectSep(o.smtc.artist, smtcSep);
      o.smtc.album = injectSep(o.smtc.album, smtcSep);
      o.titleCfg.parts = injectSep(o.titleCfg.parts, titleSep);
    }
    delete o.smtc.sep;                              // 旧字段已废弃
    delete o.titleCfg.sep;
    o.sepV2 = true;
    // 旧配置的翻译开关（读旧版本存下来的值）→ 翻译片段
    const oldTrans = (o.showTranslation === true);
    const oldTitleTrans = (o.titleCfg.showTranslation === true);
    if (oldTrans) {
      o.smtc.title = migrateTransFlag(o.smtc.title, true);
      o.smtc.artist = migrateTransFlag(o.smtc.artist, true);
      o.smtc.album = migrateTransFlag(o.smtc.album, true);
    }
    if (oldTitleTrans) o.titleCfg.parts = migrateTransFlag(o.titleCfg.parts, true);
    delete o.showTranslation;
    delete o.titleCfg.showTranslation;
    // 歌词同步：模式只认 auto / manual，偏移量限制在 ±OFF_MAX 秒内
    if (o.lyric.sync !== 'auto' && o.lyric.sync !== 'manual') o.lyric.sync = DEF_CFG.lyric.sync;
    o.lyric.offset = clampOffset(o.lyric.offset);
    return o;
  }

  function readCfg() {
    let raw = null;
    try {
      raw = (typeof GM_getValue === 'function') ? GM_getValue(CFG_KEY, null) : localStorage.getItem(CFG_KEY);
    } catch (e) { /* ignore */ }
    if (!raw) return normalizeCfg(DEF_CFG);
    try {
      const obj = (typeof raw === 'string') ? JSON.parse(raw) : raw;
      return normalizeCfg(obj);
    } catch (e) {
      return normalizeCfg(DEF_CFG);
    }
  }

  function writeCfg(next) {
    cfg = normalizeCfg(next);
    const raw = JSON.stringify(cfg);
    try {
      if (typeof GM_setValue === 'function') GM_setValue(CFG_KEY, raw);
      else localStorage.setItem(CFG_KEY, raw);
    } catch (e) { /* ignore */ }
  }

  /* ====================== Media Session 接管 ====================== */
  /* 网易云自己也会写 mediaSession.metadata，我们劫持 setter：
     - 站点的赋值 → 记录下来当作「权威歌曲信息」
     - 我们自己的赋值 → 直接走原生 setter，不污染站点信息 */

  let nativeSet = null;   // 原生 metadata setter
  let nativeGet = null;   // 原生 metadata getter
  let siteMeta = null;    // 站点自己设置的元数据（歌曲名/歌手/封面）
  let selfSetting = false;

  function snapMetadata(md) {
    if (!md) return null;
    let artwork = '';
    try {
      const arr = md.artwork || [];
      if (arr.length) artwork = arr[arr.length - 1].src || '';
    } catch (e) { /* ignore */ }
    return {
      title: md.title || '',
      artist: md.artist || '',
      album: md.album || '',
      cover: artwork
    };
  }

  function ensureHook() {
    if (nativeSet) return true;
    const ms = W.navigator && W.navigator.mediaSession;
    const MM = W.MediaMetadata || (typeof MediaMetadata !== 'undefined' ? MediaMetadata : null);
    if (!ms || !MM) return false;

    const proto = Object.getPrototypeOf(ms);
    const desc = Object.getOwnPropertyDescriptor(proto, 'metadata');
    if (!desc || !desc.set) return false;

    nativeGet = desc.get ? desc.get.bind(ms) : null;
    nativeSet = desc.set.bind(ms);

    try { siteMeta = snapMetadata(nativeGet ? nativeGet() : null); } catch (e) { /* ignore */ }

    try {
      Object.defineProperty(ms, 'metadata', {
        configurable: true,
        enumerable: desc.enumerable,
        get: function () { return nativeGet ? nativeGet() : undefined; },
        set: function (v) {
          if (!selfSetting) {
            const s = snapMetadata(v);
            if (s && (s.title || s.artist)) siteMeta = s;
          }
          desc.set.call(ms, v);
        }
      });
    } catch (e) { /* 劫持失败也没关系，后面直接用原生 setter */ }

    return true;
  }

  function applyMetadata(meta) {
    if (!ensureHook()) return;
    const MM = W.MediaMetadata;
    if (!MM) return;
    try {
      selfSetting = true;
      nativeSet(new MM(meta));
    } catch (e) { /* ignore */ } finally {
      selfSetting = false;
    }
  }

  /* ====================== 网页标题接管 ====================== */
  /* 我们自己写标题后，需要把「站点原本写的标题」单独记下来，
     否则 titleInfo() 兜底解析会读到我们自己写的标题，形成自污染 */

  let ourTitle = '';        // 我们最后一次写入的标题
  let lastSiteTitle = '';   // 站点最后一次写入的标题

  function syncSiteTitle() {
    try {
      if (document.title !== ourTitle) lastSiteTitle = document.title;
    } catch (e) { /* ignore */ }
  }

  function siteTitle() {
    try {
      return lastSiteTitle || document.title || '';
    } catch (e) { return ''; }
  }

  function applyTitle(t) {
    try {
      if (document.title !== t) document.title = t;
      ourTitle = t;
    } catch (e) { /* ignore */ }
  }

  function restoreSiteTitle() {
    if (!ourTitle) return;
    try { if (lastSiteTitle) document.title = lastSiteTitle; } catch (e) { /* ignore */ }
    ourTitle = '';
  }

  /* ========================== 页面采集 ========================== */

  const SEL = {
    song: [
      '#g_player .words .name', '.m-playbar .words .name', '.m-playbar .words .name a',
      '#g_player a.name', '.playbar .words .name',
      '[class*="playbar"] [class*="name"]'
    ],
    artist: [
      '#g_player .words .by a', '.m-playbar .words .by a', '.playbar .words .by a',
      '#g_player .words .by', '.m-playbar .words .by',
      '[class*="playbar"] [class*="artist"]', '[class*="playbar"] [class*="by"] a'
    ],
    album: [
      '#g_player .words .album', '.m-playbar .words .album',
      '[class*="playbar"] [class*="album"]'
    ],
    cover: [
      '#g_player .head img', '.m-playbar .head img', '.m-playbar img',
      '[class*="playbar"] img'
    ]
  };

  function eachDoc(cb) {
    try { cb(document); } catch (e) { /* ignore */ }
    let frames;
    try { frames = document.querySelectorAll('iframe'); } catch (e) { frames = []; }
    for (let i = 0; i < frames.length; i++) {
      let d = null;
      try { d = frames[i].contentDocument; } catch (e) { d = null; }
      if (d) { try { cb(d); } catch (e) { /* ignore */ } }
    }
  }

  function qText(doc, sels) {
    for (let i = 0; i < sels.length; i++) {
      let el = null;
      try { el = doc.querySelector(sels[i]); } catch (e) { el = null; }
      if (!el) continue;
      let v = (el.textContent || '').trim();
      if (!v && el.getAttribute) v = (el.getAttribute('title') || '').trim();
      v = v.replace(/^[\s\-–—·]+/, '').replace(/\s+/g, ' ').trim();
      if (v) return v;
    }
    return '';
  }

  function qAttr(doc, sels, attr) {
    for (let i = 0; i < sels.length; i++) {
      let el = null;
      try { el = doc.querySelector(sels[i]); } catch (e) { el = null; }
      if (!el) continue;
      const v = (el.getAttribute && el.getAttribute(attr)) || '';
      if (v) return fixUrl(v);
    }
    return '';
  }

  function fixUrl(u) {
    if (!u) return '';
    if (u.indexOf('//') === 0) return 'https:' + u;
    return u;
  }

  function upscale(u) {
    if (!u) return '';
    return u.replace(/([?&]param=)\d+y\d+/, '$1' + 500 + 'y' + 500);
  }

  /* ---- DOM 信息（带短缓存，降低开销） ---- */
  let domCache = { t: 0, v: null };

  function domInfo() {
    const now = Date.now();
    if (domCache.v && now - domCache.t < 800) return domCache.v;
    const v = { song: '', artist: '', album: '', cover: '' };
    eachDoc(function (d) {
      if (!v.song) v.song = qText(d, SEL.song);
      if (!v.artist) v.artist = qText(d, SEL.artist);
      if (!v.album) v.album = qText(d, SEL.album);
      if (!v.cover) v.cover = qAttr(d, SEL.cover, 'src');
    });
    domCache = { t: now, v: v };
    return v;
  }

  /* ---- 用站点原始标题兜底："歌名 - 歌手 - 网易云音乐" ---- */
  function titleInfo() {
    const t = siteTitle().replace(/\s*[-–—]\s*网易云音乐\s*$/, '').trim();
    if (!t) return { song: '', artist: '' };
    const parts = t.split(/\s+[-–—]\s+/);
    if (parts.length >= 2) return { song: parts[0].trim(), artist: parts.slice(1).join(' - ').trim() };
    return { song: t, artist: '' };
  }

  /* ---- 诊断信息（设置面板中展示，便于排查歌词不显示） ---- */
  const diag = {
    song: '', artist: '', id: '', idFrom: '',
    lyricRows: 0, transRows: 0, time: null, timeSrc: 'none',
    lineIndex: -1, transState: '',
    rawTime: null,           // 原始播放进度（未加偏移）
    offset: 0                // 当前生效的歌词偏移（秒）
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---- 歌名歌手 → 歌曲 id 兜底（搜索匹配） ---- */
  const searchCache = {};
  const searchPending = {};

  function similar(a, b) {
    a = String(a || '').toLowerCase().replace(/\s+/g, '');
    b = String(b || '').toLowerCase().replace(/\s+/g, '');
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return 0.85;
    let same = 0;
    for (let i = 0; i < a.length; i++) if (b.indexOf(a[i]) >= 0) same++;
    return (same / Math.max(a.length, b.length)) * 0.7;
  }

  function findCachedSongId(song, artist) {
    return searchCache[(song || '') + '|' + (artist || '')] || '';
  }

  function requestSongId(song, artist) {
    const k = (song || '') + '|' + (artist || '');
    if (!song || searchCache[k] !== undefined || searchPending[k]) return;
    searchPending[k] = 1;
    const q = encodeURIComponent(song + (artist ? ' ' + artist : ''));
    fetch(API_BASE + '/api/search/get/web?s=' + q + '&type=1&offset=0&limit=5', { credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        const list = (j && j.result && j.result.songs) || [];
        let best = null, bestScore = 0;
        for (let i = 0; i < list.length; i++) {
          const sc = similar(song, list[i].name || '');
          if (sc > bestScore) { bestScore = sc; best = list[i]; }
        }
        searchCache[k] = (best && bestScore >= 0.6) ? String(best.id) : '';
      })
      .catch(function () { searchCache[k] = ''; })
      .then(function () { delete searchPending[k]; lastApplied = ''; });
  }

  /* ---- 当前歌曲 ID ---- */
  // 从链接里提取歌曲 id：只认带 song 的路径，避免把歌单/专辑/歌手 id 当成歌曲 id
  function idFromHref(href) {
    if (!href) return '';
    const s = String(href);
    const m = s.match(/[?&]id=(\d+)/);
    if (!m) return '';
    // 只取路径部分做类型判断，避免 query 里的 userid / related_artist 之类干扰
    const path = s.split('#').pop().split('?')[0].toLowerCase();
    if (/(artist|playlist|album|dj|radio|program|user|toplist|discover|mv|video|event)/.test(path)) return '';
    return /song/.test(path) ? m[1] : '';
  }

  function getSongId() {
    let id = '', from = '';
    const scopes = ['#g_player', '.m-playbar', '.playbar', '.m-playbar .words'];
    eachDoc(function (d) {
      if (id) return;
      for (let i = 0; i < scopes.length && !id; i++) {
        let root = null;
        try { root = d.querySelector(scopes[i]); } catch (e) { root = null; }
        if (!root) continue;
        let links = [];
        try { links = root.querySelectorAll('a[href*="id="]'); } catch (e) { links = []; }
        for (let k = 0; k < links.length && !id; k++) {
          const got = idFromHref(links[k].getAttribute('href'));
          if (got) { id = got; from = 'dom'; }
        }
      }
    });
    // 地址栏兜底：必须是 song 路径（#/song?id=xxx），否则会把歌单 id 当成歌曲 id
    if (!id) {
      const m = (location.hash + location.search).match(/song[^#?]*[?&]id=(\d+)/i);
      if (m) { id = m[1]; from = 'url'; }
    }
    diag.idFrom = from;
    return id;
  }

  /* ---- 音频元素 / 播放进度 ---- */
  let boundAudio = null;

  function pickAudio() {
    const pool = [];
    eachDoc(function (d) {
      let list;
      try { list = d.querySelectorAll('audio'); } catch (e) { list = []; }
      for (let i = 0; i < list.length; i++) pool.push(list[i]);
    });
    if (!pool.length) return null;
    for (let i = 0; i < pool.length; i++) if (!pool[i].paused && pool[i].currentTime > 0) return pool[i];
    for (let i = 0; i < pool.length; i++) if (pool[i].currentTime > 0) return pool[i];
    return pool[0];
  }

  function bindAudio() {
    const a = pickAudio();
    if (!a || a === boundAudio) return;
    boundAudio = a;
    ['timeupdate', 'play', 'pause', 'seeked', 'loadedmetadata', 'durationchange'].forEach(function (ev) {
      a.addEventListener(ev, tick);
    });
  }

  /* ---- 播放进度：<audio> 优先，其次读播放栏时间文本 ---- */
  const TIME_SEL = [
    '#g_player .time em', '.m-playbar .time em', '.playbar .time em',
    '#g_player .time', '.m-playbar .time', '[class*="playbar"] [class*="time"]'
  ];
  let timeCache = { raw: null, at: 0 };

  function domTime() {
    let t = null;
    eachDoc(function (d) {
      if (t != null) return;
      const s = qText(d, TIME_SEL);
      if (!s) return;
      const m = s.match(/(\d{1,2}):(\d{2})/);
      if (m) t = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    });
    return t;
  }

  function getPlayTime() {
    const a = pickAudio();
    if (a && isFinite(a.currentTime) && a.currentTime > 0) {
      diag.timeSrc = 'audio';
      return a.currentTime;
    }
    const dt = domTime();
    if (dt != null) {
      if (timeCache.raw !== dt) { timeCache.raw = dt; timeCache.at = Date.now(); }
      diag.timeSrc = 'dom';
      // 播放栏时间文本是秒级刷新，补上已过去的时间让歌词跟上节奏（最多补 1 秒防漂移）
      return dt + Math.min((Date.now() - timeCache.at) / 1000, 1);
    }
    diag.timeSrc = 'none';
    return null;
  }

  /* ========================== 歌词处理 ========================== */

  const cache = { id: '', lrc: [], trans: [], cover: '', album: '', loading: '', ok: false, lastAt: 0 };

  // 主域下用相对路径（同源最稳），其它子域走绝对地址
  const API_BASE = (location.hostname === 'music.163.com') ? '' : 'https://music.163.com';

  function parseLrc(raw) {
    const out = [];
    if (!raw) return out;
    const re = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    const lines = String(raw).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const times = [];
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(line)) !== null) {
        const min = parseInt(m[1], 10);
        const sec = parseInt(m[2], 10);
        let frac = 0;
        if (m[3] != null) {
          const s = m[3];
          frac = (s.length === 3) ? parseInt(s, 10) : parseInt(s, 10) * Math.pow(10, 3 - s.length);
        }
        times.push(min * 60 + sec + frac / 1000);
      }
      if (!times.length) continue;
      const text = line.replace(re, '').trim();
      if (!text) continue;
      for (let k = 0; k < times.length; k++) out.push({ time: times[k], text: text });
    }
    out.sort(function (a, b) { return a.time - b.time; });
    return out;
  }

  const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/; // 汉字 / 假名
  const LTR_RE = /[A-Za-z\u00c0-\u024f]/;                                                 // 拉丁字母

  function hasCJK(s) {
    return CJK_RE.test(String(s || ''));
  }

  // 定位当前时间点落在哪一行：返回下标，-1 表示还没到第一行
  function findIndex(arr, t) {
    let i = -1;
    for (let k = arr.length - 1; k >= 0; k--) {
      if (arr[k].time <= t + 0.05) { i = k; break; }
    }
    if (i < 0) return -1;
    // 同一时间戳可能有多行（原文 / 音译 / 译文），取第一条
    while (i > 0 && Math.abs(arr[i - 1].time - arr[i].time) < 0.001) i--;
    return i;
  }

  function findLine(arr, t) {
    const i = findIndex(arr, t);
    return i < 0 ? '' : arr[i].text;
  }

  // 数组内时间与 t 最接近的一行（要求差值不超过 tol），返回下标，找不到返回 -1
  function nearIndex(arr, t, tol) {
    let best = -1, bestDiff = Infinity;
    for (let k = 0; k < arr.length; k++) {
      const d = Math.abs(arr[k].time - t);
      if (d < bestDiff) { bestDiff = d; best = k; }
      if (arr[k].time > t + tol) break;   // 数组按时间升序，超出范围即可停
    }
    return (best >= 0 && bestDiff <= tol) ? best : -1;
  }

  /* 找当前主歌词行对应的译文。
     —— 不能直接取「时间 <= t 的最后一条译文」：中英夹杂的歌里译文只覆盖英文行，
        唱到中文行时那句英文译文会被一直沿用下去。所以这里改成双向时间戳配对：
        ① 译文行的时间要贴近当前主歌词行的时间；
        ② 反过来，这条译文行最近的主歌词行必须就是当前这一行。
        只有两条都成立才算数，否则视为「本句无翻译」。 */
  const TRANS_TOL = 0.6;   // 歌曲译文与原文时间戳允许的偏差（秒）

  function transFor(mi) {
    if (mi < 0 || !cache.lrc.length) return '';
    const main = cache.lrc[mi];
    if (cache.trans.length) {
      const ti = nearIndex(cache.trans, main.time, TRANS_TOL);
      if (ti >= 0) {
        const e = cache.trans[ti];
        if (nearIndex(cache.lrc, e.time, TRANS_TOL) === mi && e.text !== main.text) return e.text;
      }
      return '';
    }
    // 没有独立译文文件时兜底：有些歌词把译文直接写在 lrc 里，与原文同一时间戳
    const k = mi + 1;
    if (k < cache.lrc.length && Math.abs(cache.lrc[k].time - main.time) < 0.05) {
      const nx = cache.lrc[k].text;
      if (hasCJK(main.text) !== hasCJK(nx) && LTR_RE.test(main.text + nx) && nx !== main.text) return nx;
    }
    return '';
  }

  /* ================= 歌词同步：自动校准 / 手动偏移 =================
     延迟从哪来：① 主循环最快 300ms 一轮，行切换最多晚 300ms 才被感知；
                 ② 系统媒体卡片（Windows 侧）自身还有几百毫秒渲染延迟，脚本观测不到。
     对策：①「自动」——把歌词切换精确排期到行时间戳那一刻，消掉主循环间隔带来的延迟；
                      能读到网易云页面歌词时，再以页面歌词为基准做微调；
           ②「手动」——滑杆直接加减偏移量，用来抵消系统媒体卡片那一侧的延迟。 */

  let autoOffset = 0;          // 自动模式下生效的偏移（秒，正 = 提前）
  const AUTO_CAP = 21;         // 偏移样本窗口大小（取中位数，抗个别抖动）
  const autoSamples = [];      // 最近的偏移样本
  let autoSeenIdx = -1;        // 上一次看到的「页面歌词行」下标
  let autoSongId = '';         // 采样所属歌曲 id
  let autoCount = 0;           // 累计有效样本数
  let autoFrom = '';           // 'site' 表示已能读到页面歌词

  const SITE_LYRIC_SEL = [
    '.m-lyric-body p',
    '#lyric-content p',
    '.m-lyric-body .m-lyric-item',
    '.m-playbar .words .lrc p',
    '#g_player .lyric p'
  ];

  function normLyric(s) {
    return String(s || '')
      .replace(/\s+/g, '')
      .replace(/^[·•\-–—]+/, '')
      .replace(/[·•\-–—]+$/, '');
  }

  function nodeVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    let r = null;
    try { r = el.getBoundingClientRect(); } catch (e) { return false; }
    return !!(r && r.width > 0 && r.height > 0);
  }

  /* 读「网易云页面上正显示的那句歌词」：
     先找带选中类的行（绝大多数播放器都会给当前行上类），
     没有的话退化为「最靠近歌词框中线的那一行」。 */
  function siteLyricText() {
    let out = '';
    eachDoc(function (d) {
      if (out) return;
      for (let s = 0; s < SITE_LYRIC_SEL.length && !out; s++) {
        let list = null;
        try { list = d.querySelectorAll(SITE_LYRIC_SEL[s]); } catch (e) { list = null; }
        if (!list || list.length < 3) continue;      // 歌词列表不可能只有两三行
        for (let i = 0; i < list.length; i++) {      // ① 选中行
          const cls = String(list[i].className || '');
          if (/(^|[\s_-])(z-sel|sel|active|current|on)([\s_-]|$)/i.test(cls)) {
            const v = normLyric(list[i].textContent);
            if (v) { out = v; return; }
          }
        }
        const box = list[0].parentNode;              // ② 歌词框中线那一行
        if (!box || !nodeVisible(box)) continue;
        const br = box.getBoundingClientRect();
        const cy = br.top + br.height / 2;
        let best = -1, bd = Infinity;
        for (let i = 0; i < list.length; i++) {
          if (!nodeVisible(list[i])) continue;
          const r = list[i].getBoundingClientRect();
          const dd = Math.abs(r.top + r.height / 2 - cy);
          if (dd < bd) { bd = dd; best = i; }
        }
        if (best >= 0) out = normLyric(list[best].textContent);
      }
    });
    return out;
  }

  /* 这句页面歌词对应我们 lrc 里的第几行。
     副歌会重复出现同一句，这里取时间上最接近当前进度的那一条，避免认错行。 */
  function lyricIdxOf(text, t) {
    const n = normLyric(text);
    if (!n || !cache.lrc.length) return -1;
    let best = -1, bd = Infinity;
    for (let i = 0; i < cache.lrc.length; i++) {
      if (normLyric(cache.lrc[i].text) !== n) continue;
      const dd = Math.abs(cache.lrc[i].time - (t == null ? 0 : t));
      if (dd < bd) { bd = dd; best = i; }
    }
    return best;
  }

  function resetAuto(id) {
    if (!id || autoSongId === id) return;
    autoSongId = id;
    autoSamples.length = 0;
    autoSeenIdx = -1;
    autoCount = 0;
    autoOffset = 0;
    autoFrom = '';
  }

  /* 采样点选在「页面歌词刚跳行的瞬间」：那一刻页面认为新行应该开始了，
     而我们读到的播放进度与它同源，两者之差就是要补偿的偏移量。
     多个样本取中位数，个别抖动就不会把偏移带偏。 */
  function autoCalibrate(raw) {
    if (raw == null || !cache.lrc.length) return;
    const txt = siteLyricText();
    if (!txt) return;
    const idx = lyricIdxOf(txt, raw);
    if (idx < 0) return;                     // 页面歌词与我们的 lrc 对不上，放弃本次采样
    autoFrom = 'site';
    if (idx === autoSeenIdx) return;         // 同一行内不重复采样
    const first = (autoSeenIdx < 0);
    autoSeenIdx = idx;
    if (first) return;                       // 第一次只记行号：不知道它是何时切过来的
    const d = cache.lrc[idx].time - raw;
    if (Math.abs(d) > 1.5) return;           // 差得离谱，多半是匹配错了行
    autoCount++;
    autoSamples.push(d);
    if (autoSamples.length > AUTO_CAP) autoSamples.shift();
    if (autoSamples.length < 3) return;      // 样本太少先不动，避免刚唱两句就乱跳
    const s = autoSamples.slice().sort(function (a, b) { return a - b; });
    autoOffset = clampOffset(s[(s.length - 1) >> 1]);
  }

  /* 给定配置下最终生效的偏移量（秒） */
  function offsetOf(c) {
    const lc = (c && c.lyric) || DEF_CFG.lyric;
    if (lc.sync === 'manual') return clampOffset(lc.offset);
    return clampOffset(autoOffset);
  }

  function fmtOffset(v) {
    const n = clampOffset(v);
    if (Math.abs(n) < 0.005) return '无偏移';
    return (n > 0 ? '提前 ' : '延后 ') + Math.abs(n).toFixed(2) + ' 秒';
  }

  /* 按给定配置的偏移重新定位歌词。面板里拖滑杆要立刻看到效果，
     所以不能只用主循环那份（它是按已保存的 cfg 定位的）。 */
  function applyLyricOffset(info, c) {
    const raw = diag.rawTime;
    if (raw == null || !cache.lrc.length) return info;
    if (info && info.id && cache.id !== info.id) return info;
    const mi = findIndex(cache.lrc, raw + offsetOf(c));
    const o = Object.assign({}, info);
    if (mi < 0) {
      o.lyric = '';
      o.lyricTrans = '';
      return o;
    }
    o.lyric = cache.lrc[mi].text;
    o.lyricTrans = transFor(mi);
    return o;
  }

  /* ---- 精确排期：在下一行的时间戳那一刻立刻刷新，而不是等下一次 300ms 轮询 ---- */
  let lineTimer = null;

  function scheduleLine() {
    if (lineTimer) { clearTimeout(lineTimer); lineTimer = null; }
    const raw = diag.time;
    if (raw == null || diag.lineIndex < 0 || !cache.lrc.length) return;
    const next = cache.lrc[diag.lineIndex + 1];
    if (!next) return;
    const wait = next.time - (raw + offsetOf(cfg));
    if (!(wait > 0.08) || wait > 5) return;   // 已在行尾或隔得太远就不排
    lineTimer = setTimeout(function () { lineTimer = null; tick(); }, Math.max(25, wait * 1000 - 30));
  }

  function ensureSongData(id) {
    if (!id) return;
    if (cache.loading === id) return;                       // 请求中
    if (cache.id === id && cache.ok) return;                // 已成功加载
    if (cache.id === id && Date.now() - cache.lastAt < 2500) return; // 同一首失败后冷却重试
    cache.lastAt = Date.now();
    cache.loading = id;
    cache.id = id;
    cache.ok = false;
    cache.lrc = [];
    cache.trans = [];

    const pLyric = fetch(API_BASE + '/api/song/lyric?os=pc&id=' + id + '&lv=-1&kv=-1&tv=-1', { credentials: 'include' })
      .then(function (r) { return r.json(); }).catch(function () { return null; });
    const pDetail = fetch(API_BASE + '/api/song/detail?ids=%5B' + id + '%5D', { credentials: 'include' })
      .then(function (r) { return r.json(); }).catch(function () { return null; });

    Promise.all([pLyric, pDetail]).then(function (res) {
      if (cache.id !== id) return;
      const ly = res[0], dt = res[1];
      let got = false;
      if (ly) {
        got = true;
        cache.lrc = parseLrc(ly.lrc && ly.lrc.lyric);
        cache.trans = parseLrc(ly.tlyric && ly.tlyric.lyric);
      }
      if (dt && dt.songs && dt.songs[0]) {
        got = true;
        const al = dt.songs[0].album || {};
        cache.cover = fixUrl(al.picUrl || '');
        cache.album = al.name || '';
      }
      cache.ok = got;
      lastApplied = '';
      tick();
    }).then(function () {
      if (cache.loading === id) cache.loading = '';
    });
  }

  /* ========================== 主循环 ========================== */

  let lastApplied = '';
  let lastInfo = null;

  function collect() {
    syncSiteTitle();
    ensureHook();
    bindAudio();

    const d = domInfo();
    const info = {
      id: '',
      song: (siteMeta && siteMeta.title) || d.song,
      artist: (siteMeta && siteMeta.artist) || d.artist,
      album: d.album || '',
      cover: upscale((siteMeta && siteMeta.cover) || d.cover || ''),
      lyric: '',        // 本句原文
      lyricTrans: ''    // 本句译文（按时间戳配对得出，可能为空）
    };

    if (!info.song) {
      const t = titleInfo();
      info.song = t.song;
      if (!info.artist) info.artist = t.artist;
    }

    /* ---- 歌曲 id：播放栏链接 → 地址栏 → 用歌名歌手搜索兜底 ---- */
    let id = getSongId();
    if (!id && info.song) {
      id = findCachedSongId(info.song, info.artist);
      if (id) diag.idFrom = 'search';
      else requestSongId(info.song, info.artist);
    }
    info.id = id;
    if (id) { resetAuto(id); ensureSongData(id); }

    if (!info.album) info.album = cache.album;
    if (!info.cover) info.cover = upscale(cache.cover);

    /* ---- 播放进度 → 当前歌词（先叠加歌词偏移，再做时间戳定位） ---- */
    const t = getPlayTime();
    const off = offsetOf(cfg);
    diag.rawTime = t;
    diag.offset = off;
    diag.transState = '';
    diag.lineIndex = -1;
    if (t != null && id && cache.id === id && cache.lrc.length) {
      const mi = findIndex(cache.lrc, t + off);
      diag.lineIndex = mi;
      if (mi >= 0) {
        info.lyric = cache.lrc[mi].text;
        // 译文一律配对好放进 info.lyricTrans：用不用取决于片段列表里有没有「翻译」片段，
        // 所以这里不做开关判断 —— 面板里增删「翻译」片段能立刻在预览看到效果
        const tr = transFor(mi);
        if (tr) {
          info.lyricTrans = tr;
          diag.transState = 'matched';
        } else {
          diag.transState = 'none';   // 本句确实没有翻译，不会沿用上一句
        }
      }
    }
    // 自动模式：以页面歌词为基准微调偏移（拿不到页面歌词时静默跳过）
    if (cfg.lyric.sync === 'auto') autoCalibrate(t);

    /* ---- 诊断快照 ---- */
    diag.song = info.song;
    diag.artist = info.artist;
    diag.id = id;
    diag.lyricRows = (cache.id === id) ? cache.lrc.length : 0;
    diag.transRows = (cache.id === id) ? cache.trans.length : 0;
    diag.time = t;

    lastInfo = info;
    return info;
  }

  /* 通用片段拼接：按 parts 顺序取值。
     普通片段取不到内容（没歌手 / 本句无译文）时整段跳过，不留空位；
     「连接符」片段只在自己前面已经出现过内容片段时才落地，
     所以把它放在开头、结尾或连放几个，都不会拼出多余的符号。
     注意「歌词」只出原文、「翻译」只出译文，两者都是普通片段，位置由用户排 */
  function joinParts(info, parts) {
    const values = {
      song: info.song || '',
      artist: info.artist || '',
      album: info.album || '',
      lyric: info.lyric || '',
      trans: info.lyricTrans || '',
      site: ''
    };
    const list = Array.isArray(parts) ? parts : [];
    let out = '';
    let pending = '';     // 攒着的连接符：等下一个有内容的片段来了才落地
    let has = false;      // 是否已经拼出过内容
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p || !PART_META[p.type]) continue;
      if (p.type === 'sep') {
        if (has || pending) pending += (typeof p.text === 'string') ? p.text : SEP_DEF;
        continue;
      }
      const v = (p.type === 'site') ? String(p.text || '').trim() : values[p.type];
      if (!v) continue;
      if (has && pending) out += pending;
      pending = '';
      out += v;
      has = true;
    }
    return out;
  }

  // 系统媒体三栏文案（标题栏 / 歌手栏 / 专辑栏）
  function composeSmtc(info, c) {
    const conf = c || cfg;
    const s = conf.smtc || DEF_CFG.smtc;
    const title = joinParts(info, s.title);
    return {
      title: title || info.song || '网易云音乐',   // 标题为空时兜底歌名，免得卡片空白
      artist: joinParts(info, s.artist),
      album: joinParts(info, s.album)
    };
  }

  // 网页标题拼接
  function composeTitle(info, tc) {
    if (!tc || !tc.enabled) return '';
    return joinParts(info, tc.parts);
  }

  function tick() {
    try { ensureFab(); } catch (e) { /* ignore */ }
    let info;
    try { info = collect(); } catch (e) { return; }

    if (!cfg.enabled) {
      if (lastApplied) {
        lastApplied = '';
        if (ensureHook() && siteMeta) {
          const MM = W.MediaMetadata;
          if (MM) {
            try {
              selfSetting = true;
              nativeSet(new MM({
                title: siteMeta.title || '',
                artist: siteMeta.artist || '',
                album: siteMeta.album || ''
              }));
            } catch (e) { /* ignore */ } finally { selfSetting = false; }
          }
        }
      }
      restoreSiteTitle();
      if (lineTimer) { clearTimeout(lineTimer); lineTimer = null; }
      updatePreview(info);
      return;
    }

    /* ---- 系统媒体（三栏） ---- */
    const meta = composeSmtc(info, cfg);
    const cover = cfg.showArtwork ? (info.cover || '') : '';
    const key = meta.title + '\u0000' + meta.artist + '\u0000' + meta.album + '\u0000' + cover;
    if (key !== lastApplied) {
      lastApplied = key;
      const payload = { title: meta.title, artist: meta.artist, album: meta.album };
      if (cover) payload.artwork = [{ src: cover, sizes: '500x500', type: 'image/jpeg' }];
      applyMetadata(payload);
    }

    /* ---- 网页标题 ---- */
    const tc = cfg.titleCfg;
    if (tc && tc.enabled) {
      const t = composeTitle(info, tc);
      if (t) { if (t !== ourTitle) applyTitle(t); }
      else restoreSiteTitle();
    } else {
      restoreSiteTitle();
    }

    updatePreview(info);
    scheduleLine();   // 在下一行的时间戳那一刻再醒一次，消掉轮询间隔带来的延迟
  }

  /* ======================= 页面内快捷入口 ======================= */
  /* 脚本管理器的菜单入口有的版本藏得很深，这里给一个页面内可见入口：
     右下角齿轮按钮 / Ctrl+Alt+S */

  let fab = null;

  const FAB_CSS = [
    ':host{all:initial}',
    '.fab{width:34px;height:34px;border-radius:50%;border:0;cursor:pointer;display:flex;align-items:center;justify-content:center;',
    '  background:rgba(255,255,255,.92);box-shadow:0 2px 10px rgba(0,0,0,.16);color:#8a8a8a;padding:0;',
    '  transition:background .2s ease,color .2s ease,transform .2s ease,box-shadow .2s ease}',
    '.fab:hover{background:#ec4141;color:#fff;transform:scale(1.08);box-shadow:0 4px 14px rgba(236,65,65,.4)}',
    '.fab:active{transform:scale(.96)}',
    '.fab svg{width:17px;height:17px;display:block;pointer-events:none}'
  ].join('\n');

  const FAB_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="12" cy="12" r="3"></circle>' +
    '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>' +
    '</svg>';

  function ensureFab() {
    if (!document.body) return;
    if (!fab) {
      fab = document.createElement('div');
      fab.style.cssText = 'position:fixed;right:20px;bottom:140px;z-index:2147483000;';
      const sr = fab.attachShadow({ mode: 'open' });
      const st = document.createElement('style');
      st.textContent = FAB_CSS;
      sr.appendChild(st);

      const btn = document.createElement('button');
      btn.className = 'fab';
      btn.type = 'button';
      btn.title = '网易云音乐设置增强 NCMWSE（Ctrl+Alt+S）';
      btn.innerHTML = FAB_SVG;
      btn.addEventListener('click', function (e) { e.stopPropagation(); openPanel(); });
      sr.appendChild(btn);

      document.body.appendChild(fab);
    }
    fab.style.display = cfg.showFab ? '' : 'none';
  }

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.altKey && (e.code === 'KeyS' || e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      e.stopPropagation();
      openPanel();
    }
  }, true);

  /* ========================== 设置面板 ========================== */

  let host = null;      // shadow 宿主
  let shadow = null;
  let draft = null;     // 编辑中的临时配置
  let els = null;
  let ioMode = '';      // 当前导入/导出弹层的模式
  let curTab = 'general';   // 当前选项卡（记住用户上次停留的页）

  const CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;margin:0;padding:0}',
    '.mask{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;',
    '  font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;',
    '  opacity:0;transition:opacity .2s ease}',
    '.mask.show{opacity:1}',
    '.card{width:800px;max-width:calc(100vw - 40px);height:min(700px,calc(100vh - 48px));display:flex;flex-direction:column;',
    '  background:#fff;border-radius:14px;box-shadow:0 22px 60px rgba(0,0,0,.32);overflow:hidden;opacity:.5;',
    '  transform:translateY(16px) scale(.97);',
    '  transition:transform .26s cubic-bezier(.2,.9,.3,1),opacity .22s ease}',
    '.mask.show .card{transform:none;opacity:1}',
    '.hd{padding:15px 20px;font-size:15px;font-weight:600;color:#1f1f1f;border-bottom:1px solid #f0f0f0;flex:none;',
    '  display:flex;align-items:center;justify-content:space-between;background:#fff}',
    '.hd .dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#ec4141;margin-right:8px;',
    '  vertical-align:1px;box-shadow:0 0 0 3px rgba(236,65,65,.13)}',
    '.x{width:28px;height:28px;border:0;background:transparent;border-radius:7px;cursor:pointer;color:#999;',
    '  font-size:18px;line-height:1;transition:background .18s,color .18s,transform .26s ease}',
    '.x:hover{background:#f5f5f5;color:#333;transform:rotate(90deg)}',
    '',
    '.main{flex:1;min-height:0;display:flex}',
    '.tabs{width:172px;flex:none;position:relative;padding:12px 10px;background:#fafafa;border-right:1px solid #f0f0f0}',
    '.pill{position:absolute;left:10px;right:10px;top:0;height:38px;border-radius:9px;background:#fff;',
    '  border:1px solid #f4e2e2;box-shadow:0 2px 7px rgba(236,65,65,.08);z-index:0;opacity:0;',
    '  transition:transform .34s cubic-bezier(.32,.72,.24,1),height .34s cubic-bezier(.32,.72,.24,1),opacity .24s}',
    '.tab{position:relative;z-index:1;display:flex;align-items:center;gap:8px;width:100%;height:38px;padding:0 12px;',
    '  border:0;background:transparent;border-radius:9px;font:13.5px/1 inherit;color:#6b6b6b;cursor:pointer;',
    '  text-align:left;transition:color .2s,transform .16s}',
    '.tab+.tab{margin-top:2px}',
    '.tab:hover{color:#333}',
    '.tab:active{transform:scale(.98)}',
    '.tab.active{color:#ec4141;font-weight:600}',
    '.tick{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none;opacity:.25;transform:scale(.7);',
    '  transition:opacity .22s,transform .26s cubic-bezier(.2,.9,.3,1)}',
    '.tab.active .tick{opacity:1;transform:none}',
    '.pages{flex:1;min-width:0;overflow:auto;padding:16px 20px 4px}',
    '.page{display:none}',
    '.page.active{display:block;animation:pageIn .3s cubic-bezier(.22,.9,.3,1) both}',
    '@keyframes pageIn{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:none}}',
    '.cols{display:grid;grid-template-columns:1fr 232px;gap:16px;align-items:start}',
    '.col-side{position:sticky;top:-4px}',
    '',
    '.row{display:flex;align-items:center;justify-content:space-between;padding:8px 0;color:#333;cursor:pointer;font-size:14px}',
    '.glabel{font-size:12px;color:#999;margin:12px 0 6px}',
    'select{width:100%;height:34px;border:1px solid #e5e5e5;border-radius:7px;padding:0 8px;background:#fff;',
    '  color:#333;font-size:13px;outline:none;transition:border-color .18s,box-shadow .18s}',
    'select:focus{border-color:#ec4141;box-shadow:0 0 0 3px rgba(236,65,65,.09)}',
    'input.sw{appearance:none;-webkit-appearance:none;width:38px;height:21px;border-radius:11px;background:#ddd;',
    '  position:relative;cursor:pointer;transition:background .2s;flex:none;border:0;outline:none}',
    'input.sw::after{content:"";position:absolute;top:2px;left:2px;width:17px;height:17px;border-radius:50%;',
    '  background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .22s cubic-bezier(.2,.9,.3,1)}',
    'input.sw:checked{background:#ec4141}',
    'input.sw:checked::after{transform:translateX(17px)}',
    '.sep{height:1px;background:#f0f0f0;margin:16px -20px 0}',
    '.sect{font-size:13px;font-weight:600;color:#333;margin:14px 0 8px}',
    '.infobox{border:1px solid #f0f0f0;border-radius:10px;background:#fafafa;padding:4px 12px}',
    '.irow{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;font-size:12.5px;',
    '  color:#8a8a8a;border-bottom:1px dashed #ededed}',
    '.irow:last-child{border-bottom:0}',
    '.irow b{color:#444;font-weight:500}',
    '.irow code{font:11.5px/1 Consolas,Menlo,monospace;background:#f1f1f1;border-radius:4px;padding:3px 6px;color:#666}',
    '.preview{margin:14px 0 6px;padding:11px 12px;border-radius:10px;background:#fafafa;border:1px solid #f0f0f0}',
    '.col-side .preview:first-child{margin-top:0}',
    '.plabel{font-size:12px;color:#999;margin-bottom:8px}',
    '.pbox{background:#2b2b2b;border-radius:8px;padding:9px 12px}',
    '.ptitle{color:#fff;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.partist{color:#b3b3b3;font-size:12px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:17px}',
    '.palbum{color:#8b8b8b;font-size:11.5px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:16px}',
    '.ptbox{margin-top:6px;padding:8px 10px;border-radius:8px;background:#fff;border:1px solid #eee;',
    '  font-size:12px;color:#444;word-break:break-all;line-height:1.6}',
    '.tabdemo{display:flex;align-items:center;gap:7px;background:#f1f1f1;border-radius:0 0 8px 8px;padding:9px 10px}',
    '.tabdemo .fav{width:12px;height:12px;border-radius:3px;flex:none;background:linear-gradient(135deg,#ec4141,#ff9090)}',
    '.tabdemo .tt{font-size:12px;color:#555;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.presets{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 6px}',
    '.chip{height:27px;padding:0 10px;border-radius:14px;border:1px solid #e7e7e7;background:#fafafa;color:#555;',
    '  font:12px/1 inherit;cursor:pointer;transition:all .18s}',
    '.chip:hover{border-color:#ec4141;color:#ec4141;background:#fff6f6}',
    '.chip:active{transform:scale(.95)}',
    '.mhd{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:#666;margin:12px 0 5px}',
    '.mhint{font-size:11px;color:#c2c2c2}',
    '.frags{border:1px solid #eee;border-radius:10px;overflow:hidden;background:#fcfcfc}',
    '.frag{display:flex;align-items:center;gap:8px;padding:7px 10px;background:#fff;border-bottom:1px solid #f2f2f2;',
    '  cursor:grab;transition:background .16s,opacity .16s,box-shadow .16s}',
    '.frag:last-child{border-bottom:0}',
    '.frag:hover{background:#fafafa}',
    '.frag.dragging{opacity:.45;background:#fff6f6;box-shadow:inset 0 0 0 1px #f7d5d5}',
    '.frag-new{animation:fragIn .28s cubic-bezier(.2,.9,.3,1) both}',
    '@keyframes fragIn{from{opacity:0;transform:translateX(-7px)}to{opacity:1;transform:none}}',
    '.grip{color:#c8c8c8;font-size:13px;letter-spacing:-2px;user-select:none;cursor:grab;flex:none}',
    '.fname{font-size:13px;color:#333;flex:none;min-width:56px}',
    '.frag.fsep{background:#fcfcfc}',
    '.frag.fsep .fname{color:#a9a9a9}',
    '.frag.fsep .ftext{flex:none;width:96px;text-align:center;color:#999;background:#fbfbfb}',
    '.frag.fsep .ftext:focus{color:#555;background:#fff}',
    '.ftext{flex:1;min-width:0;height:26px;border:1px solid #e8e8e8;border-radius:6px;padding:0 7px;font-size:12px;',
    '  color:#555;outline:none;cursor:text;transition:border-color .18s}',
    '.ftext:focus{border-color:#ec4141}',
    '.del{width:22px;height:22px;border:0;background:transparent;border-radius:5px;color:#bbb;cursor:pointer;',
    '  font-size:15px;line-height:1;flex:none;transition:all .16s}',
    '.del:hover{background:#fdecec;color:#ec4141;transform:scale(1.08)}',
    '.addrow{display:flex;gap:8px;margin-top:8px}',
    '.addrow select{flex:1}',
    '.diag{margin:0 0 6px;padding:12px;border-radius:10px;background:#fbfbfb;border:1px solid #f0f0f0}',
    '.dbox{margin-top:6px;font-size:12px;color:#555;line-height:1.9;word-break:break-all}',
    '.tip{margin-top:10px;font-size:12px;color:#aaa;line-height:1.6}',
    '.hint{margin:6px 0 2px;padding-left:2px;font-size:11.5px;color:#bbb;line-height:1.6}',
    '',
    '/* 歌词同步：自动/手动分段控件 + 偏移滑杆 */',
    '.seg{display:inline-flex;gap:2px;padding:3px;margin:2px 0 12px;background:#f4f4f5;border-radius:9px}',
    '.segb{height:28px;padding:0 18px;border:0;border-radius:7px;background:transparent;color:#777;font:13px/1 inherit;',
    '  cursor:pointer;transition:background .22s,color .22s,box-shadow .22s,transform .16s}',
    '.segb:hover{color:#333}',
    '.segb:active{transform:scale(.96)}',
    '.segb.on{background:#fff;color:#ec4141;font-weight:600;box-shadow:0 1px 4px rgba(0,0,0,.09)}',
    '.syncbox{margin:0 0 12px;animation:syncIn .26s cubic-bezier(.22,.9,.3,1) both}',
    '@keyframes syncIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}',
    '.labrow{display:flex;align-items:center;justify-content:space-between;font-size:12.5px;color:#777;margin-bottom:9px}',
    '.labrow b{color:#ec4141;font-weight:600;font-variant-numeric:tabular-nums;transition:color .2s}',
    '.rng{-webkit-appearance:none;appearance:none;width:100%;height:4px;border-radius:3px;background:#eee;outline:none;cursor:pointer}',
    '.rng::-webkit-slider-thumb{-webkit-appearance:none;width:15px;height:15px;border-radius:50%;background:#ec4141;',
    '  border:2px solid #fff;box-shadow:0 1px 5px rgba(236,65,65,.45);transition:transform .16s}',
    '.rng::-webkit-slider-thumb:hover{transform:scale(1.18)}',
    '.rng::-moz-range-thumb{width:13px;height:13px;border-radius:50%;background:#ec4141;border:2px solid #fff;cursor:pointer}',
    '.rngends{display:flex;justify-content:space-between;font-size:11px;color:#c0c0c0;margin:7px 0 10px}',
    '',
    '.ft{padding:11px 18px 14px;display:flex;align-items:center;gap:10px;justify-content:flex-end;flex:none;',
    '  border-top:1px solid #f4f4f4;background:#fff}',
    '.ftinfo{margin-right:auto;font-size:11.5px;color:#c4c4c4}',
    '.btn{height:34px;padding:0 16px;border-radius:8px;border:1px solid transparent;font-size:13px;cursor:pointer;',
    '  font-family:inherit;transition:all .18s}',
    '.btn:active{transform:scale(.97)}',
    '.btn.primary{background:#ec4141;color:#fff;box-shadow:0 3px 10px rgba(236,65,65,.24)}',
    '.btn.primary:hover{background:#d73535;box-shadow:0 4px 14px rgba(236,65,65,.3)}',
    '.btn.ghost{background:#fff;color:#666;border-color:#e5e5e5}',
    '.btn.ghost:hover{background:#f7f7f7;color:#333;border-color:#ddd}',
    '.btn.mini{height:34px;padding:0 14px;background:#f5f5f5;color:#444;border-color:#ececec}',
    '.btn.mini:hover{background:#ececec}',
    '',
    '.iomask{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.34);',
    '  border-radius:14px}',
    '.iomask.show{display:flex}',
    '.iocard{width:560px;max-width:calc(100vw - 40px);max-height:calc(100vh - 60px);display:flex;flex-direction:column;',
    '  background:#fff;border-radius:14px;box-shadow:0 22px 60px rgba(0,0,0,.32);overflow:auto;',
    '  animation:cardIn .26s cubic-bezier(.2,.9,.3,1) both}',
    '@keyframes cardIn{from{opacity:0;transform:translateY(12px) scale(.98)}to{opacity:1;transform:none}}',
    '.bd{padding:12px 18px 4px}',
    '.ta{width:100%;height:210px;border:1px solid #e5e5e5;border-radius:8px;padding:9px 10px;color:#333;outline:none;',
    '  resize:vertical;font:12px/1.55 Consolas,Menlo,monospace;transition:border-color .18s}',
    '.ta:focus{border-color:#ec4141}',
    '.iohint{min-height:17px;margin-top:7px;font-size:12px;color:#aaa;line-height:1.5}',
    '.iohint.err{color:#ec4141}',
    '.iohint.ok{color:#18a058}',
    '',
    '@media (max-width:780px){',
    '  .card{width:calc(100vw - 24px);height:min(88vh,calc(100vh - 24px))}',
    '  .main{flex-direction:column}',
    '  .tabs{width:100%;display:flex;gap:6px;padding:9px 12px;border-right:0;border-bottom:1px solid #f0f0f0;overflow-x:auto}',
    '  .pill{display:none}',
    '  .tab{width:auto;flex:none;padding:0 14px;border:1px solid transparent}',
    '  .tab+.tab{margin-top:0}',
    '  .tab.active{background:#fff;border-color:#f4e2e2;box-shadow:0 1px 4px rgba(236,65,65,.08)}',
    '  .pages{padding:14px 14px 4px}',
    '  .cols{grid-template-columns:1fr}',
    '  .col-side{position:static}',
    '  .sep{margin-left:-14px;margin-right:-14px}',
    '}'
  ].join('\n');


  const HTML = [
    '<div class="mask" data-role="mask">',
    '  <div class="card">',
    '    <div class="hd">',
    '      <span><i class="dot"></i>网易云音乐设置增强 NCMWSE</span>',
    '      <button class="x" data-role="close" title="关闭">&times;</button>',
    '    </div>',
    '    <div class="main">',
    '      <nav class="tabs" data-role="tabs">',
    '        <div class="pill" data-role="pill"></div>',
    '        <button class="tab" type="button" data-tab="general"><i class="tick"></i>常规</button>',
    '        <button class="tab" type="button" data-tab="lyric"><i class="tick"></i>歌词同步</button>',
    '        <button class="tab" type="button" data-tab="smtc"><i class="tick"></i>系统媒体</button>',
    '        <button class="tab" type="button" data-tab="title"><i class="tick"></i>网页标题</button>',
    '        <button class="tab" type="button" data-tab="diag"><i class="tick"></i>诊断信息</button>',
    '      </nav>',
    '      <div class="pages" data-role="pages">',
    '',
    '        <section class="page" data-page="general">',
    '          <label class="row"><span>启用显示增强</span><input class="sw" type="checkbox" data-k="enabled"></label>',
    '          <label class="row"><span>显示右下角设置按钮</span><input class="sw" type="checkbox" data-k="showFab"></label>',
    '          <label class="row"><span>显示专辑封面</span><input class="sw" type="checkbox" data-k="showArtwork"></label>',
    '          <div class="sep"></div>',
    '          <div class="sect">运行信息</div>',
    '          <div class="infobox">',
    '            <div class="irow"><span>脚本版本</span><b>NCMWSE v' + VER + '</b></div>',
    '            <div class="irow"><span>设置入口</span><b>右下角齿轮按钮 · <code>Ctrl + Alt + S</code></b></div>',
    '            <div class="irow"><span>生效范围</span><b>music.163.com</b></div>',
    '          </div>',
    '          <div class="tip">修改后点「保存并关闭」才会生效。需要页面处于播放状态，系统媒体控制才会出现；歌词不显示时到「诊断信息」页看卡在哪一步。</div>',
    '        </section>',
    '',
    '        <section class="page" data-page="lyric">',
    '          <div class="cols">',
    '            <div>',
    '              <div class="sect" style="margin-top:0">歌词同步</div>',
    '              <div class="seg" data-role="syncSeg">',
    '                <button type="button" class="segb" data-v="auto">自动</button>',
    '                <button type="button" class="segb" data-v="manual">手动</button>',
    '              </div>',
    '',
    '              <div class="syncbox" data-role="autoBox">',
    '                <div class="irow"><span>自动校准</span><b data-role="autoState">—</b></div>',
    '                <div class="irow"><span>当前偏移</span><b data-role="autoVal">—</b></div>',
    '              </div>',
    '',
    '              <div class="syncbox" data-role="manualBox">',
    '                <div class="labrow"><span>偏移量</span><b data-role="offVal">无偏移</b></div>',
    '                <input class="rng" type="range" min="-3" max="3" step="0.05" data-k="lyricOffset">',
    '                <div class="rngends"><span>延后 3 秒</span><span>0</span><span>提前 3 秒</span></div>',
    '                <div class="addrow">',
    '                  <button class="btn mini" data-role="offm">延后 0.1 秒</button>',
    '                  <button class="btn mini" data-role="offz">归零</button>',
    '                  <button class="btn mini" data-role="offp">提前 0.1 秒</button>',
    '                </div>',
    '              </div>',
    '',
    '              <div class="hint" data-role="syncHint"></div>',
    '            </div>',
    '            <aside class="col-side">',
    '              <div class="preview">',
    '                <div class="plabel">实时对照</div>',
    '                <div class="irow"><span>播放进度</span><b data-role="lRaw">—</b></div>',
    '                <div class="irow"><span>生效偏移</span><b data-role="lOff">—</b></div>',
    '                <div class="ptbox" data-role="lNow">—</div>',
    '              </div>',
    '              <div class="tip">一边放歌一边调最准：把系统媒体卡片上显示的歌词，和右上「实时对照」里这一句对着看。<br>改了要点「保存并关闭」才生效。</div>',
    '            </aside>',
    '          </div>',
    '        </section>',
    '',
    '        <section class="page" data-page="smtc">',
    '          <div class="cols">',
    '            <div>',
    '              <div class="glabel">快速预设</div>',
    '              <div class="presets" data-role="presetsSmtc"></div>',
    '              <div class="hint">「翻译」和歌曲名/歌手一样是可拖拽的片段：把它加进某一栏，就显示当前这句歌词的译文。译文按时间戳与本句原文配对 —— 本句没有译文时该片段为空、不会沿用上一句。</div>',
    '              <div class="hint">「连接符」也是片段：在每栏下方的「添加片段」里选「连接符」，再拖到需要加分隔的位置，文本随改随用；一栏里可以放多个、各不相同（如歌手前用「 - 」、专辑前用「 · 」）。</div>',
    '              <div data-role="smtcMods"></div>',
    '            </div>',
    '            <aside class="col-side">',
    '              <div class="preview">',
    '                <div class="plabel">实时预览 · 系统媒体卡片</div>',
    '                <div class="pbox">',
    '                  <div class="ptitle" data-role="pv1">—</div>',
    '                  <div class="partist" data-role="pv2">—</div>',
    '                  <div class="palbum" data-role="pv3">—</div>',
    '                </div>',
    '              </div>',
    '            </aside>',
    '          </div>',
    '        </section>',
    '',
    '        <section class="page" data-page="title">',
    '          <div class="cols">',
    '            <div>',
    '              <label class="row"><span>自定义网页标题</span><input class="sw" type="checkbox" data-k="titleEnabled"></label>',
    '              <div class="glabel">快速预设</div>',
    '              <div class="presets" data-role="presetsTitle"></div>',
    '              <div class="mhd"><span>标题栏</span><span class="mhint">按住拖动排序，点 × 删除</span></div>',
    '              <div class="frags" data-role="frags_pageTitle"></div>',
    '              <div class="addrow">',
    '                <select data-role="addsel_pageTitle"></select>',
    '                <button class="btn mini" data-role="addbtn_pageTitle">添加片段</button>',
    '              </div>',
    '              <div class="hint">分隔符由「连接符」片段负责：在「添加片段」里选「连接符」，拖到两个片段中间即可；不想要分隔就别放它。</div>',
    '            </div>',
    '            <aside class="col-side">',
    '              <div class="preview">',
    '                <div class="plabel">网页标题预览</div>',
    '                <div class="ptbox" data-role="ptitle">—</div>',
    '              </div>',
    '              <div class="preview">',
    '                <div class="plabel">标签页示意</div>',
    '                <div class="tabdemo"><i class="fav"></i><span class="tt" data-role="ptitle2">—</span></div>',
    '              </div>',
    '            </aside>',
    '          </div>',
    '        </section>',
    '',
    '        <section class="page" data-page="diag">',
    '          <div class="diag">',
    '            <div class="plabel">实时诊断（播放时每 300ms 刷新）</div>',
    '            <div class="dbox" data-role="diag">—</div>',
    '          </div>',
    '          <div class="sect">怎么看</div>',
    '          <div class="tip">',
    '            · <b>歌曲 ID 未获取到</b> → 歌曲链接与搜索兜底都没命中，歌词自然拿不到。<br>',
    '            · <b>歌词未获取到但 ID 正常</b> → 这首歌本身可能没歌词（纯音乐）。<br>',
    '            · <b>播放进度未取到</b> → 播放栏结构可能变了，反馈给我补选择器。<br>',
    '            · <b>全都正常但媒体卡片没歌词</b> → 到「系统媒体」页确认那一栏里有「歌词」片段。',
    '          </div>',
    '        </section>',
    '',
    '      </div>',
    '    </div>',
    '    <div class="ft">',
    '      <span class="ftinfo">NCMWSE v' + VER + '</span>',
    '      <button class="btn ghost" data-role="reset">恢复默认</button>',
    '      <button class="btn ghost" data-role="export">导出</button>',
    '      <button class="btn ghost" data-role="import">导入</button>',
    '      <button class="btn primary" data-role="save">保存并关闭</button>',
    '    </div>',
    '  </div>',
    '',
    '  <div class="iomask" data-role="iomask">',
    '    <div class="iocard">',
    '      <div class="hd"><span data-role="iotitle">导入配置</span><button class="x" data-role="ioclose" title="关闭">&times;</button></div>',
    '      <div class="bd">',
    '        <textarea class="ta" data-role="iotext" spellcheck="false"></textarea>',
    '        <div class="iohint" data-role="iohint"></div>',
    '      </div>',
    '      <div class="ft">',
    '        <button class="btn ghost" data-role="iofile">从文件导入…</button>',
    '        <button class="btn ghost" data-role="iodl">下载为文件</button>',
    '        <button class="btn ghost" data-role="iocopy">复制</button>',
    '        <button class="btn primary" data-role="iook">导入</button>',
    '        <button class="btn ghost" data-role="ioclose2">关闭</button>',
    '      </div>',
    '      <input type="file" accept=".json,.txt,application/json" data-role="iofileinput" style="display:none">',
    '    </div>',
    '  </div>',
    '</div>'
  ].join('\n');


  /* ---- draft 键值映射（部分设置项嵌在 titleCfg / smtc 里） ---- */
  function keyGet(k) {
    if (!draft) return undefined;
    if (k === 'titleEnabled') return draft.titleCfg.enabled;
    if (k === 'lyricOffset') return draft.lyric.offset;
    return draft[k];
  }

  function keySet(k, v) {
    if (!draft) return;
    if (k === 'titleEnabled') draft.titleCfg.enabled = v;
    else if (k === 'lyricOffset') draft.lyric.offset = clampOffset(v);   // 滑杆给的是字符串
    else draft[k] = v;
  }

  /* ---- 四个可编辑模块：SMTC 标题栏/歌手栏/专辑栏 + 网页标题栏 ----
     每个模块就是一份片段列表，渲染/拖拽/增删逻辑完全一样 */
  const MODS = [
    { id: 'smtcTitle', label: '标题栏', hint: 'SMTC 第一行', box: 'frags_smtcTitle',
      get: function (d) { return d.smtc.title; }, set: function (d, a) { d.smtc.title = a; } },
    { id: 'smtcArtist', label: '歌手栏', hint: 'SMTC 第二行', box: 'frags_smtcArtist',
      get: function (d) { return d.smtc.artist; }, set: function (d, a) { d.smtc.artist = a; } },
    { id: 'smtcAlbum', label: '专辑栏', hint: 'SMTC 第三行', box: 'frags_smtcAlbum',
      get: function (d) { return d.smtc.album; }, set: function (d, a) { d.smtc.album = a; } },
    { id: 'pageTitle', label: '标题栏', hint: '浏览器标签页', box: 'frags_pageTitle',
      get: function (d) { return d.titleCfg.parts; }, set: function (d, a) { d.titleCfg.parts = a; } }
  ];

  const fragCtx = {};    // 模块 id → { mod, box, map, get, set }
  let dragRow = null;    // 正在拖动的行
  let pidSeq = 0;

  function renderMods() {
    MODS.forEach(function (mod) { renderMod(mod.id); });
  }

  function renderMod(id) {
    const ctx = fragCtx[id];
    if (!ctx || !draft || !ctx.box) return;
    const box = ctx.box;
    box.innerHTML = '';
    ctx.map = {};

    const parts = ctx.get(draft) || [];
    if (!parts.length) {
      const empty = document.createElement('div');
      empty.className = 'frag';
      empty.style.cssText = 'justify-content:center;color:#bbb;font-size:12px;cursor:default';
      empty.textContent = '暂无片段，请从下方添加';
      box.appendChild(empty);
      return;
    }

    parts.forEach(function (p) {
      const meta = PART_META[p.type];
      if (!meta) return;

      const pid = 'p' + (++pidSeq);
      ctx.map[pid] = p;

      const row = document.createElement('div');
      const isSep = (p.type === 'sep');
      row.className = isSep ? 'frag fsep' : 'frag';
      row.draggable = true;
      row.dataset.pid = pid;

      const grip = document.createElement('span');
      grip.className = 'grip';
      grip.textContent = '≡';
      row.appendChild(grip);

      const name = document.createElement('span');
      name.className = 'fname';
      name.textContent = meta.name;
      row.appendChild(name);

      if (meta.hasText) {
        const inp = document.createElement('input');
        inp.className = 'ftext';
        inp.type = 'text';
        inp.draggable = false;
        inp.value = p.text || '';
        inp.placeholder = isSep ? '如  -  /  ·  /  |' : (meta.def || '');
        inp.title = isSep ? '连接符文本：会补在前后两个有内容的片段之间' : '';
        inp.addEventListener('input', function () {
          p.text = inp.value;
          refreshPreview();
        });
        row.appendChild(inp);
      }

      const del = document.createElement('button');
      del.className = 'del';
      del.type = 'button';
      del.draggable = false;
      del.title = '删除该片段';
      del.innerHTML = '&times;';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        ctx.set(draft, (ctx.get(draft) || []).filter(function (x) { return x !== p; }));
        renderMod(id);
        refreshPreview();
      });
      row.appendChild(del);

      bindDrag(ctx, row);
      box.appendChild(row);
    });
  }

  function bindDrag(ctx, row) {
    /* --- 拖拽排序 --- */
    row.addEventListener('dragstart', function (e) {
      dragRow = row;
      row.classList.add('dragging');
      try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', row.dataset.pid || '');
      } catch (err) { /* ignore */ }
    });

    row.addEventListener('dragend', function () {
      row.classList.remove('dragging');
      dragRow = null;
      syncOrder(ctx);
      renderMod(ctx.mod.id);
      refreshPreview();
    });

    row.addEventListener('dragover', function (e) {
      if (!dragRow || dragRow === row) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (err) { /* ignore */ }
      const rect = row.getBoundingClientRect();
      if ((e.clientY - rect.top) > rect.height / 2) row.after(dragRow);
      else row.before(dragRow);
    });

    row.addEventListener('drop', function (e) { e.preventDefault(); });
  }

  // 按当前 DOM 顺序回写该模块的片段数组（拖拽过程中节点已被移动）
  function syncOrder(ctx) {
    if (!ctx || !draft) return;
    const cur = ctx.get(draft) || [];
    const rows = ctx.box.querySelectorAll('.frag');
    const arr = [];
    for (let i = 0; i < rows.length; i++) {
      const p = ctx.map[rows[i].dataset.pid];
      if (!p) continue;
      const inp = rows[i].querySelector('input');
      if (inp) p.text = inp.value;
      arr.push(p);
    }
    if (arr.length || !cur.length) ctx.set(draft, arr);
  }

  function syncAllOrder() {
    MODS.forEach(function (mod) { syncOrder(fragCtx[mod.id]); });
  }

  /* ---- 预设 ---- */
  function partsOf(list) {
    return (list || []).map(function (t) { return defPart(t); });
  }

  function applySmtcPreset(ps) {
    if (!draft) return;
    draft.smtc.title = partsOf(ps.title);
    draft.smtc.artist = partsOf(ps.artist);
    draft.smtc.album = partsOf(ps.album);
    fillPanel();
    flashRows(['smtcTitle', 'smtcArtist', 'smtcAlbum'], true);
    refreshPreview();
  }

  function applyTitlePreset(ps) {
    if (!draft) return;
    draft.titleCfg.enabled = true;
    draft.titleCfg.parts = partsOf(ps.parts);
    fillPanel();
    flashRows(['pageTitle'], true);
    refreshPreview();
  }

  function renderPresets(box, list, onClick) {
    if (!box) return;
    box.innerHTML = '';
    list.forEach(function (ps) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.textContent = ps.name;
      b.title = '套用预设：' + ps.name;
      b.addEventListener('click', function () { onClick(ps); });
      box.appendChild(b);
    });
  }

  /* ---- 导入 / 导出 ---- */
  function cfgBlob() {
    return JSON.stringify({
      app: 'NCMWSE',
      name: '网易云音乐设置增强(NCMWSE)',
      version: VER,
      exportedAt: new Date().toISOString(),
      cfg: normalizeCfg(draft || cfg)
    }, null, 2);
  }

  function ioMsg(text, cls) {
    if (!els || !els.ioHint) return;
    els.ioHint.textContent = text || '';
    els.ioHint.className = 'iohint' + (cls ? ' ' + cls : '');
  }

  function openIO(mode) {
    if (!els) return;
    ioMode = mode;
    const isExport = (mode === 'export');
    els.ioTitle.textContent = isExport ? '导出配置' : '导入配置';
    els.ioText.value = isExport ? cfgBlob() : '';
    els.ioText.readOnly = isExport;
    els.ioText.placeholder = isExport ? '' : '把导出的 JSON 粘贴到这里，或点「从文件导入…」';
    ioMsg(isExport ? '复制保存或下载为 .json，可在别的浏览器或机器上导入。'
                   : '导入会替换当前设置，确认无误后点「保存并关闭」生效。', '');
    els.iofile.style.display = isExport ? 'none' : '';
    els.ioOk.style.display = isExport ? 'none' : '';
    els.iocopy.style.display = isExport ? '' : 'none';
    els.iodl.style.display = isExport ? '' : 'none';
    els.ioClose2.textContent = isExport ? '关闭' : '取消';
    els.ioMask.classList.add('show');
  }

  function closeIO() {
    if (!els) return;
    els.ioMask.classList.remove('show');
    els.ioText.value = '';
    ioMsg('', '');
  }

  function doImport(text) {
    let obj = null;
    try {
      obj = JSON.parse(String(text || '').trim());
    } catch (e) {
      ioMsg('JSON 格式不合法，请检查是否复制完整。', 'err');
      return false;
    }
    const raw = (obj && typeof obj === 'object' && !Array.isArray(obj) && obj.cfg) ? obj.cfg : obj;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      ioMsg('没找到配置内容，请确认是导出的 JSON。', 'err');
      return false;
    }
    draft = normalizeCfg(raw);
    fillPanel();
    refreshPreview();
    ioMsg('导入成功，点「保存并关闭」后生效。', 'ok');
    return true;
  }

  // 复制兜底：没有剪贴板权限时用 execCommand
  function legacyCopy() {
    try {
      const wasRO = els.ioText.readOnly;
      els.ioText.readOnly = false;
      els.ioText.select();
      const ok = document.execCommand('copy');
      els.ioText.readOnly = wasRO;
      return ok;
    } catch (e) { return false; }
  }

  function buildPanel() {
    if (host) return;
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:none;';
    shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    const wrap = document.createElement('div');
    wrap.innerHTML = HTML;
    shadow.appendChild(wrap);

    // SMTC 三个模块骨架（结构一致，按需生成，省得 HTML 里抄三遍）
    const modsBox = shadow.querySelector('[data-role="smtcMods"]');
    if (modsBox) {
      let html = '';
      MODS.forEach(function (m) {
        if (m.id === 'pageTitle') return;
        html += '<div class="mhd"><span>' + esc(m.label) + '</span><span class="mhint">' + esc(m.hint) +
          ' · 按住拖动排序</span></div>' +
          '<div class="frags" data-role="' + m.box + '"></div>' +
          '<div class="addrow"><select data-role="addsel_' + m.id + '"></select>' +
          '<button class="btn mini" data-role="addbtn_' + m.id + '">添加片段</button></div>';
      });
      modsBox.innerHTML = html;
    }

    els = {
      mask: shadow.querySelector('[data-role="mask"]'),
      tabs: shadow.querySelector('[data-role="tabs"]'),
      pill: shadow.querySelector('[data-role="pill"]'),
      tabBtns: shadow.querySelectorAll('.tab'),
      pages: shadow.querySelectorAll('.page'),
      pagesBox: shadow.querySelector('[data-role="pages"]'),
      pv1: shadow.querySelector('[data-role="pv1"]'),
      pv2: shadow.querySelector('[data-role="pv2"]'),
      pv3: shadow.querySelector('[data-role="pv3"]'),
      ptitle: shadow.querySelector('[data-role="ptitle"]'),
      ptitle2: shadow.querySelector('[data-role="ptitle2"]'),
      diag: shadow.querySelector('[data-role="diag"]'),
      presetsSmtc: shadow.querySelector('[data-role="presetsSmtc"]'),
      presetsTitle: shadow.querySelector('[data-role="presetsTitle"]'),
      segBtns: shadow.querySelectorAll('[data-role="syncSeg"] .segb'),
      autoBox: shadow.querySelector('[data-role="autoBox"]'),
      manualBox: shadow.querySelector('[data-role="manualBox"]'),
      autoState: shadow.querySelector('[data-role="autoState"]'),
      autoVal: shadow.querySelector('[data-role="autoVal"]'),
      offVal: shadow.querySelector('[data-role="offVal"]'),
      rangeOffset: shadow.querySelector('[data-k="lyricOffset"]'),
      syncHint: shadow.querySelector('[data-role="syncHint"]'),
      lRaw: shadow.querySelector('[data-role="lRaw"]'),
      lOff: shadow.querySelector('[data-role="lOff"]'),
      lNow: shadow.querySelector('[data-role="lNow"]'),
      ioMask: shadow.querySelector('[data-role="iomask"]'),
      ioTitle: shadow.querySelector('[data-role="iotitle"]'),
      ioText: shadow.querySelector('[data-role="iotext"]'),
      ioHint: shadow.querySelector('[data-role="iohint"]'),
      iofile: shadow.querySelector('[data-role="iofile"]'),
      iofileinput: shadow.querySelector('[data-role="iofileinput"]'),
      iodl: shadow.querySelector('[data-role="iodl"]'),
      iocopy: shadow.querySelector('[data-role="iocopy"]'),
      ioOk: shadow.querySelector('[data-role="iook"]'),
      ioClose2: shadow.querySelector('[data-role="ioclose2"]'),
      inputs: shadow.querySelectorAll('[data-k]')
    };

    // 片段模块：绑定容器、填充「添加片段」下拉、绑定添加按钮
    MODS.forEach(function (mod) {
      const box = shadow.querySelector('[data-role="' + mod.box + '"]');
      const sel = shadow.querySelector('[data-role="addsel_' + mod.id + '"]');
      const ctx = { mod: mod, box: box, map: {}, get: mod.get, set: mod.set };
      fragCtx[mod.id] = ctx;
      if (sel) {
        PART_ORDER.forEach(function (t) {
          const op = document.createElement('option');
          op.value = t;
          op.textContent = PART_META[t].name;
          sel.appendChild(op);
        });
      }
      const btn = shadow.querySelector('[data-role="addbtn_' + mod.id + '"]');
      if (btn) {
        btn.addEventListener('click', function () {
          if (!sel || !draft || !PART_META[sel.value]) return;
          syncOrder(ctx);
          const arr = ctx.get(draft) || [];
          arr.push(defPart(sel.value));
          ctx.set(draft, arr);
          renderMod(mod.id);
          flashRows([mod.id], false);   // 只让新加的那行滑入
          refreshPreview();
        });
      }
    });

    renderPresets(els.presetsSmtc, SMTC_PRESETS, applySmtcPreset);
    renderPresets(els.presetsTitle, TITLE_PRESETS, applyTitlePreset);

    // 选项卡切换
    Array.prototype.forEach.call(els.tabBtns, function (b) {
      b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); });
    });

    els.mask.addEventListener('click', function (e) {
      if (e.target === els.mask || (e.target.getAttribute && e.target.getAttribute('data-role') === 'close')) closePanel();
    });

    els.ioMask.addEventListener('click', function (e) {
      if (e.target === els.ioMask) closeIO();
    });

    Array.prototype.forEach.call(els.inputs, function (el) {
      el.addEventListener('change', function () {
        const k = el.getAttribute('data-k');
        keySet(k, (el.type === 'checkbox') ? el.checked : el.value);
        refreshPreview();
      });
    });

    /* ---- 歌词同步：自动 / 手动 + 偏移量 ---- */
    Array.prototype.forEach.call(els.segBtns, function (b) {
      b.addEventListener('click', function () {
        if (!draft) return;
        draft.lyric.sync = (b.getAttribute('data-v') === 'manual') ? 'manual' : 'auto';
        updateSyncUI();
        refreshPreview();
      });
    });

    if (els.rangeOffset) {
      els.rangeOffset.addEventListener('input', function () {
        keySet('lyricOffset', this.value);
        if (els.offVal) els.offVal.textContent = fmtOffset(draft.lyric.offset);
        refreshPreview();
      });
    }

    const nudge = function (d) {
      if (!draft) return;
      draft.lyric.offset = clampOffset(draft.lyric.offset + d);
      updateSyncUI();
      refreshPreview();
    };
    const bindNudge = function (role, d) {
      const b = shadow.querySelector('[data-role="' + role + '"]');
      if (b) b.addEventListener('click', function () { nudge(d); });
    };
    bindNudge('offm', -0.1);
    bindNudge('offp', 0.1);
    const offZero = shadow.querySelector('[data-role="offz"]');
    if (offZero) {
      offZero.addEventListener('click', function () {
        if (!draft) return;
        draft.lyric.offset = 0;
        updateSyncUI();
        refreshPreview();
      });
    }

    shadow.querySelector('[data-role="reset"]').addEventListener('click', function () {
      draft = normalizeCfg(DEF_CFG);
      fillPanel();
      refreshPreview();
    });

    shadow.querySelector('[data-role="export"]').addEventListener('click', function () { openIO('export'); });
    shadow.querySelector('[data-role="import"]').addEventListener('click', function () { openIO('import'); });
    shadow.querySelector('[data-role="ioclose"]').addEventListener('click', closeIO);
    els.ioClose2.addEventListener('click', closeIO);
    els.ioOk.addEventListener('click', function () { doImport(els.ioText.value); });
    els.ioText.addEventListener('input', function () { ioMsg('', ''); });

    els.iofile.addEventListener('click', function () { els.iofileinput.click(); });
    els.iofileinput.addEventListener('change', function () {
      const f = this.files && this.files[0];
      if (!f) return;
      const fr = new FileReader();
      fr.onload = function () {
        els.ioText.value = String(fr.result || '');
        ioMsg('已读入文件内容，点「导入」应用。', '');
      };
      fr.onerror = function () { ioMsg('文件读取失败。', 'err'); };
      try { fr.readAsText(f); } catch (e) { ioMsg('文件读取失败。', 'err'); }
      this.value = '';
    });

    els.iocopy.addEventListener('click', function () {
      const txt = els.ioText.value;
      const done = function () { ioMsg('已复制到剪贴板。', 'ok'); };
      const fail = function () { ioMsg('复制失败，请手动全选复制。', 'err'); };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(txt).then(done, function () { if (legacyCopy()) done(); else fail(); });
          return;
        }
      } catch (e) { /* 落到下面的兜底 */ }
      if (legacyCopy()) done(); else fail();
    });

    els.iodl.addEventListener('click', function () {
      try {
        const blob = new Blob([els.ioText.value], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'NCMWSE-config.json';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
          try { document.body.removeChild(a); } catch (e) { /* ignore */ }
          URL.revokeObjectURL(url);
        }, 1000);
        ioMsg('已触发下载。', 'ok');
      } catch (e) { ioMsg('下载失败，请用「复制」手动保存。', 'err'); }
    });

    shadow.querySelector('[data-role="save"]').addEventListener('click', function () {
      syncAllOrder();
      writeCfg(draft);
      lastApplied = '';
      tick();
      closePanel();
    });

    const root = document.documentElement || document.body;
    if (root) root.appendChild(host);

    // 窗口尺寸变化时（含窄屏切换为横向选项卡）重新校准指示块
    window.addEventListener('resize', function () {
      if (host && host.style.display !== 'none') movePill();
    });
  }

  function fillPanel() {
    if (!els || !draft) return;
    Array.prototype.forEach.call(els.inputs, function (el) {
      const k = el.getAttribute('data-k');
      const v = keyGet(k);
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v;
    });
    renderMods();
    updateSyncUI();
  }

  /* ========================== 选项卡 ========================== */

  // 切换选项卡：滑动指示块 + 页面淡入上移
  function showTab(id) {
    if (!els || !els.tabBtns) return;
    let ok = false;
    Array.prototype.forEach.call(els.tabBtns, function (b) {
      if (b.getAttribute('data-tab') === id) ok = true;
    });
    if (!ok) id = 'general';
    curTab = id;

    Array.prototype.forEach.call(els.tabBtns, function (b) {
      const on = b.getAttribute('data-tab') === id;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });

    // 先摘掉 active 再强制重排，保证每次切页动画都会重播
    Array.prototype.forEach.call(els.pages, function (p) {
      const on = p.getAttribute('data-page') === id;
      p.classList.remove('active');
      if (on) {
        void p.offsetWidth;
        p.classList.add('active');
      }
    });

    if (els.pagesBox) els.pagesBox.scrollTop = 0;
    movePill();
  }

  // 让白色指示块滑到当前选项卡的位置（宽高随选项卡量取）
  function movePill() {
    const pill = els && els.pill;
    if (!pill) return;
    let act = null;
    Array.prototype.forEach.call(els.tabBtns || [], function (b) {
      if (!act && b.classList.contains('active')) act = b;
    });
    const h = act ? act.offsetHeight : 0;
    if (!act || !h) {
      // 面板刚打开时可能还没完成布局，量不到尺寸；稍后再量一次（只重试一次）
      pill.style.opacity = '0';
      if (!movePill.timer) {
        movePill.timer = setTimeout(function () { movePill.timer = 0; movePill(); }, 80);
      }
      return;
    }
    pill.style.height = h + 'px';
    pill.style.transform = 'translateY(' + act.offsetTop + 'px)';
    pill.style.opacity = '1';
  }

  // 让某些模块的片段行依次滑入（套用预设时用），stagger=true 时逐行错开
  function flashRows(ids, stagger) {
    if (!els) return;
    (ids || []).forEach(function (id) {
      const ctx = fragCtx[id];
      if (!ctx || !ctx.box) return;
      const rows = ctx.box.querySelectorAll('.frag');
      for (let i = 0; i < rows.length; i++) {
        rows[i].classList.remove('frag-new');
        void rows[i].offsetWidth;
        rows[i].style.animationDelay = stagger ? (i * 32) + 'ms' : '0ms';
        rows[i].classList.add('frag-new');
      }
    });
  }

  /* ---- 歌词同步选项卡：模式切换、偏移量显示 ---- */
  function updateSyncUI() {
    if (!els || !draft) return;
    const lc = draft.lyric;
    Array.prototype.forEach.call(els.segBtns || [], function (b) {
      b.classList.toggle('on', b.getAttribute('data-v') === lc.sync);
    });
    if (els.autoBox) els.autoBox.style.display = (lc.sync === 'auto') ? '' : 'none';
    if (els.manualBox) els.manualBox.style.display = (lc.sync === 'manual') ? '' : 'none';
    if (els.rangeOffset) els.rangeOffset.value = lc.offset;
    if (els.offVal) els.offVal.textContent = fmtOffset(lc.offset);
    if (els.syncHint) {
      els.syncHint.textContent = (lc.sync === 'manual')
        ? '正值 = 歌词提前显示（歌词慢于声音时往右拖）；负值 = 歌词延后显示。'
        : '自动模式下，歌词切换会精确排期到行时间戳那一刻，消掉脚本轮询间隔带来的延迟；能读到网易云页面上的歌词时，还会以页面歌词为基准微调。系统媒体卡片自身还有几百毫秒渲染延迟（脚本观测不到）——若仍觉得慢，切到手动加一点「提前」。';
    }
    updateSyncLive();
  }

  // 每帧刷新「自动校准状态」与右侧实时对照（面板开着时才跑）
  function updateSyncLive() {
    if (!els || !els.autoVal || !draft) return;
    if (autoFrom === 'site') {
      els.autoState.textContent = autoCount ? ('已对齐页面歌词 · 样本 ' + autoCount) : '正在采样…';
    } else {
      els.autoState.textContent = '未检测到页面歌词';
    }
    els.autoVal.textContent = fmtOffset(autoOffset);

    if (els.lRaw) els.lRaw.textContent = (diag.time == null) ? '未获取到' : diag.time.toFixed(2) + ' 秒';
    if (els.lOff) els.lOff.textContent = fmtOffset(offsetOf(draft));
    if (els.lNow) {
      const it = applyLyricOffset(lastInfo || {}, draft);
      els.lNow.textContent = (it.lyric || '—') + (it.lyricTrans ? ' · ' + it.lyricTrans : '');
    }
  }

  function fillPreview(info, c) {
    const it = applyLyricOffset(info, c);   // 按当前配置的偏移重新定位歌词，拖滑杆时预览立刻变
    const meta = composeSmtc(it, c);
    els.pv1.textContent = meta.title || '—';
    els.pv2.textContent = meta.artist || '—';
    els.pv3.textContent = meta.album || '—';
    const pt = composeTitle(it, c.titleCfg) || '';
    els.ptitle.textContent = pt || '—';
    if (els.ptitle2) els.ptitle2.textContent = pt || '—';
  }

  function refreshPreview() {
    if (!els || !draft) return;
    fillPreview(lastInfo || { song: '', artist: '', album: '', lyric: '', lyricTrans: '' }, draft);
    updateSyncLive();
  }

  function updatePreview(info) {
    if (!els || !host || host.style.display === 'none' || !draft) return;
    fillPreview(info, draft);
    updateDiag();
    updateSyncLive();
  }

  // 诊断用：当前歌词同步状态
  function syncLine() {
    const lc = cfg.lyric || DEF_CFG.lyric;
    if (lc.sync === 'manual') return '手动 · ' + fmtOffset(lc.offset);
    return '自动 · ' + fmtOffset(autoOffset) + '（' +
      (autoFrom === 'site' ? '已对齐页面歌词 · 样本 ' + autoCount : '未检测到页面歌词') + '）';
  }

  function updateDiag() {
    if (!els || !els.diag) return;
    const srcMap = { dom: '播放栏链接', url: '地址栏', search: '搜索匹配', '': '未取到' };
    const timeMap = { audio: 'audio 元素', dom: '播放栏时间', none: '未取到' };
    const rows = [
      '歌曲：' + esc(diag.song || '—') + (diag.artist ? ' / ' + esc(diag.artist) : ''),
      '歌曲 ID：' + (diag.id ? esc(diag.id) + '（来源：' + (srcMap[diag.idFrom] || '—') + '）' : '未获取到'),
      '歌词：' + (diag.lyricRows > 0 ? diag.lyricRows + ' 行已加载' : '未获取到') +
        ' · 翻译 ' + (diag.transRows > 0 ? diag.transRows + ' 行' : '无') +
        (diag.transState === 'matched' ? '（本句已匹配）' : (diag.transState === 'none' ? '（本句无翻译）' : '')),
      '播放进度：' + (diag.time == null ? '未获取到' : diag.time.toFixed(1) + ' 秒') + '（' + (timeMap[diag.timeSrc] || diag.timeSrc) + '）',
      '歌词同步：' + esc(syncLine()),
      '当前歌词：' + (diag.lineIndex >= 0 ? '第 ' + (diag.lineIndex + 1) + ' 行 · ' : '') + esc((lastInfo && lastInfo.lyric) || '—')
    ];
    els.diag.innerHTML = rows.join('<br>');
  }

  function openPanel() {
    buildPanel();
    if (!host) return;
    draft = cloneCfg(cfg);
    fillPanel();
    refreshPreview();
    host.style.display = '';

    // 淡入 + 恢复上次停留的选项卡。用 rAF 让过渡有起始帧可动；
    // 但标签页在后台时 rAF 会被浏览器暂停，因此用定时器兜底，保证面板一定会出现。
    let shown = false;
    const show = function () {
      if (shown || !host || !els) return;
      shown = true;
      els.mask.classList.add('show');
      showTab(curTab);
    };
    requestAnimationFrame(show);
    setTimeout(show, 60);
  }

  function closePanel() {
    if (!host) return;
    els.mask.classList.remove('show');
    setTimeout(function () { if (host) host.style.display = 'none'; }, 190);
  }

  /* ========================== 菜单入口 ========================== */

  let menuOk = false;
  if (typeof GM_registerMenuCommand === 'function') {
    try {
      GM_registerMenuCommand('显示设置', openPanel);
      GM_registerMenuCommand('立即重新同步', function () { lastApplied = ''; domCache = { t: 0, v: null }; tick(); });
      GM_registerMenuCommand('清空歌词缓存并重试', function () {
        cache.id = ''; cache.ok = false; cache.loading = '';
        cache.lrc = []; cache.trans = [];
        lastApplied = ''; domCache = { t: 0, v: null };
        tick();
      });
      menuOk = true;
    } catch (e) { menuOk = false; }
  }

  try {
    console.log('%c[NCMWSE]%c Netease Cloud Music WEB Setting Enhancement v' + VER + ' 已启动' + (menuOk ? '（脚本菜单已注册）' : '（当前管理器不支持脚本菜单，请用页面按钮或快捷键）') +
      '；设置入口：页面右下角齿轮 / 脚本管理器菜单「显示设置」/ Ctrl+Alt+S',
      'color:#ec4141;font-weight:bold', 'color:#888');
  } catch (e) { /* ignore */ }

  /* ========================== 启动 ========================== */

  setInterval(tick, 300);
  tick();
})();
