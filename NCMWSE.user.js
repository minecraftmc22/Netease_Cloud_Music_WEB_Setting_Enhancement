// ==UserScript==
// @name         网易云音乐设置增强(NCMWSE)
// @name:en      Netease Cloud Music WEB Setting Enhancement
// @namespace    https://github.com/minecraftmc22/Netease_Cloud_Music_WEB_Setting_Enhancement
// @version      1.3.4
// @description  检测网易云音乐网页版正在播放的歌曲，把歌曲信息同步到系统媒体控制（SMTC）。SMTC 的标题栏/歌手栏/专辑栏与网页标题栏均为可拖拽排序的片段模块（歌曲名/歌手/歌词/专辑/网站名称），带快速预设、独立翻译开关、歌词时间戳配对、配置导入导出与诊断信息
// @description:en  Detect the song playing on Netease Cloud Music web player, sync "song / artist" or "current lyric / song-artist" to Windows SMTC, and customize the page title with drag-and-drop segments.
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
   *      每栏都是一份「片段列表」（歌曲名 / 歌手 / 歌词 / 专辑 / 网站名称），
   *      可拖拽排序、增删，三栏共用一个片段连接符；
   *      内置预设：歌曲名/歌手、歌词/歌曲名 - 歌手。
   *      「歌词」片段是否带译文由「启用翻译?（系统媒体）」单独控制。
   * 2) 网页标题：同样的片段列表，可拖拽排序，
   *      内置预设：歌曲名 - 歌手 - 网站名称 / 歌词(翻译) - 歌曲名 - 歌手 / 歌词(翻译)。
   *      译文由「启用翻译?（网页标题）」单独控制，与系统媒体那个互不影响。
   * 3) 配置可导出为 JSON（复制或下载），也能从粘贴内容 / 文件导入。
   * ========================================================================= */

  const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  if (W.top !== W.self) return; // 只在顶层文档运行

  /* ============================ 配置 ============================ */

  const CFG_KEY = 'ncm_smtc_cfg';
  const VER = '1.3.4';

  // 可用的片段类型
  const PART_META = {
    song: { name: '歌曲名', hasText: false },
    artist: { name: '歌手', hasText: false },
    lyric: { name: '歌词', hasText: false },
    album: { name: '专辑', hasText: false },
    site: { name: '网站名称', hasText: true, def: '网易云音乐' }
  };
  const PART_ORDER = ['song', 'artist', 'lyric', 'album', 'site'];

  function defPart(type) {
    const m = PART_META[type];
    return { type: type, text: (m && m.hasText) ? (m.def || '') : '' };
  }

  // 四个可编辑的「片段模块」：SMTC 的标题栏/歌手栏/专辑栏 + 网页标题栏
  const DEF_CFG = {
    enabled: true,
    showFab: true,            // 页面右下角显示设置按钮
    showArtwork: true,        // 显示专辑封面
    showTranslation: false,   // SMTC 的「歌词」片段是否带译文
    smtc: {
      sep: ' - ',             // 三栏共用的片段连接符
      title: [defPart('song')],
      artist: [defPart('artist')],
      album: [defPart('album')]
    },
    titleCfg: {                // 网页标题
      enabled: false,
      showTranslation: false,  // 网页标题里的「歌词」片段是否带译文
      sep: ' - ',
      parts: [defPart('song'), defPart('artist'), defPart('site')]
    }
  };

  /* 预设：SMTC 两组、网页标题三组（applyPreset 会连译文开关一起设好） */
  const SMTC_PRESETS = [
    { name: '歌曲名 / 歌手', sep: ' - ', trans: false, title: ['song'], artist: ['artist'], album: ['album'] },
    { name: '歌词 / 歌曲名 - 歌手', sep: ' - ', trans: false, title: ['lyric'], artist: ['song', 'artist'], album: ['album'] }
  ];

  const TITLE_PRESETS = [
    { name: '歌曲名 - 歌手 - 网站名称', sep: ' - ', trans: false, parts: ['song', 'artist', 'site'] },
    { name: '歌词(翻译) - 歌曲名 - 歌手', sep: ' - ', trans: true, parts: ['lyric', 'song', 'artist'] },
    { name: '歌词(翻译)', sep: ' - ', trans: true, parts: ['lyric'] }
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

  // 读取时做一次合法性校验
  function normalizeCfg(c) {
    const o = cloneCfg(c);
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
    if (typeof o.smtc.sep !== 'string') o.smtc.sep = DEF_CFG.smtc.sep;
    if (typeof o.titleCfg.sep !== 'string') o.titleCfg.sep = DEF_CFG.titleCfg.sep;
    if (typeof o.showTranslation !== 'boolean') o.showTranslation = DEF_CFG.showTranslation;
    if (typeof o.titleCfg.showTranslation !== 'boolean') o.titleCfg.showTranslation = DEF_CFG.titleCfg.showTranslation;
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
    lineIndex: -1, transState: ''
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
    if (id) ensureSongData(id);

    if (!info.album) info.album = cache.album;
    if (!info.cover) info.cover = upscale(cache.cover);

    /* ---- 播放进度 → 当前歌词（原文/译文分开存，SMTC 与网页标题各自决定要不要译文） ---- */
    const t = getPlayTime();
    diag.transState = '';
    diag.lineIndex = -1;
    if (t != null && id && cache.id === id && cache.lrc.length) {
      const mi = findIndex(cache.lrc, t);
      diag.lineIndex = mi;
      if (mi >= 0) {
        info.lyric = cache.lrc[mi].text;
        // 译文统一配对好放在 info.lyricTrans 里，用不用由 compose / composeTitle 各自的开关决定
        // （这样设置面板里切换开关能立刻看到效果，不必先保存）
        const tr = transFor(mi);
        if (tr) {
          info.lyricTrans = tr;
          diag.transState = 'matched';
        } else {
          diag.transState = 'none';   // 本句确实没有翻译，不再沿用上一句
        }
      }
    }

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

  // 按需把译文拼到原文后面 —— SMTC 与网页标题各用各的开关，互不影响
  function lyricText(info, wantTrans) {
    const main = info.lyric || '';
    if (!wantTrans) return main;
    const tr = info.lyricTrans || '';
    if (!tr || tr === main) return main;
    return main ? (main + ' · ' + tr) : tr;
  }

  /* 通用片段拼接：按 parts 顺序取值，空片段（如未取到的歌手）自动跳过，
     避免拼出多余的分隔符 */
  function joinParts(info, parts, sep, wantTrans) {
    const values = {
      song: info.song || '',
      artist: info.artist || '',
      album: info.album || '',
      lyric: lyricText(info, wantTrans),
      site: ''
    };
    const segs = [];
    const list = Array.isArray(parts) ? parts : [];
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p || !PART_META[p.type]) continue;
      const v = (p.type === 'site') ? String(p.text || '').trim() : values[p.type];
      if (v) segs.push(v);
    }
    return segs.join(typeof sep === 'string' ? sep : ' - ');
  }

  // 系统媒体三栏文案（标题栏 / 歌手栏 / 专辑栏）
  function composeSmtc(info, c) {
    const conf = c || cfg;
    const s = conf.smtc || DEF_CFG.smtc;
    const trans = !!conf.showTranslation;
    const title = joinParts(info, s.title, s.sep, trans);
    return {
      title: title || info.song || '网易云音乐',   // 标题为空时兜底歌名，免得卡片空白
      artist: joinParts(info, s.artist, s.sep, trans),
      album: joinParts(info, s.album, s.sep, trans)
    };
  }

  // 网页标题拼接
  function composeTitle(info, tc) {
    if (!tc || !tc.enabled) return '';
    return joinParts(info, tc.parts, tc.sep, tc.showTranslation);
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

  const SEP_PRESETS = [' - ', ' · ', ' | ', ''];

  const CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;margin:0;padding:0}',
    '.mask{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;',
    '  font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;',
    '  opacity:0;transition:opacity .18s ease}',
    '.mask.show{opacity:1}',
    '.card{width:424px;max-width:calc(100vw - 32px);max-height:calc(100vh - 36px);overflow:auto;background:#fff;border-radius:12px;',
    '  box-shadow:0 18px 48px rgba(0,0,0,.3);transform:translateY(10px) scale(.98);',
    '  transition:transform .22s cubic-bezier(.2,.9,.3,1)}',
    '.mask.show .card{transform:none}',
    '.hd{padding:15px 18px;font-size:15px;font-weight:600;color:#1f1f1f;border-bottom:1px solid #f0f0f0;',
    '  display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:#fff;z-index:2;border-radius:12px 12px 0 0}',
    '.x{width:26px;height:26px;border:0;background:transparent;border-radius:6px;cursor:pointer;color:#999;',
    '  font-size:18px;line-height:1;transition:all .18s}',
    '.x:hover{background:#f5f5f5;color:#333}',
    '.bd{padding:12px 18px 4px}',
    '.row{display:flex;align-items:center;justify-content:space-between;padding:7px 0;color:#333;cursor:pointer;font-size:14px}',
    '.glabel{font-size:12px;color:#999;margin:10px 0 6px}',
    'select{width:100%;height:34px;border:1px solid #e5e5e5;border-radius:7px;padding:0 8px;background:#fff;',
    '  color:#333;font-size:13px;outline:none;transition:border-color .18s}',
    'select:focus{border-color:#ec4141}',
    'input.sw{appearance:none;-webkit-appearance:none;width:38px;height:21px;border-radius:11px;background:#ddd;',
    '  position:relative;cursor:pointer;transition:background .18s;flex:none;border:0;outline:none}',
    'input.sw::after{content:"";position:absolute;top:2px;left:2px;width:17px;height:17px;border-radius:50%;',
    '  background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .18s}',
    'input.sw:checked{background:#ec4141}',
    'input.sw:checked::after{transform:translateX(17px)}',
    '.collapse{max-height:0;opacity:0;overflow:hidden;transition:max-height .24s ease,opacity .2s ease}',
    '.collapse.show{max-height:96px;opacity:1}',
    '.sep{height:1px;background:#f0f0f0;margin:14px -18px 0}',
    '.sect{font-size:13px;font-weight:600;color:#333;margin:14px 0 2px}',
    '.preview{margin:14px 0 6px;padding:11px 12px;border-radius:9px;background:#fafafa;border:1px solid #f0f0f0}',
    '.plabel{font-size:12px;color:#999;margin-bottom:8px}',
    '.pbox{background:#2b2b2b;border-radius:8px;padding:9px 12px}',
    '.ptitle{color:#fff;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.partist{color:#b3b3b3;font-size:12px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:17px}',
    '.palbum{color:#8b8b8b;font-size:11.5px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:16px}',
    '.presets{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 4px}',
    '.chip{height:27px;padding:0 10px;border-radius:14px;border:1px solid #e7e7e7;background:#fafafa;color:#555;',
    '  font-size:12px;font-family:inherit;cursor:pointer;transition:all .16s}',
    '.chip:hover{border-color:#ec4141;color:#ec4141;background:#fff6f6}',
    '.chip:active{transform:scale(.97)}',
    '.mhd{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:#666;margin:11px 0 5px}',
    '.mhint{font-size:11px;color:#c2c2c2}',
    '.iomask{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.32);border-radius:12px}',
    '.iomask.show{display:flex}',
    '.iocard{width:424px;max-width:calc(100vw - 32px);max-height:calc(100vh - 40px);display:flex;flex-direction:column;',
    '  background:#fff;border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.3);overflow:auto}',
    '.ta{width:100%;height:188px;border:1px solid #e5e5e5;border-radius:8px;padding:9px 10px;color:#333;outline:none;',
    '  resize:vertical;font:12px/1.55 Consolas,Menlo,monospace;transition:border-color .18s}',
    '.ta:focus{border-color:#ec4141}',
    '.iohint{min-height:17px;margin-top:7px;font-size:12px;color:#aaa;line-height:1.5}',
    '.iohint.err{color:#ec4141}',
    '.iohint.ok{color:#18a058}',
    '.frags{border:1px solid #eee;border-radius:9px;overflow:hidden;background:#fcfcfc}',
    '.frag{display:flex;align-items:center;gap:8px;padding:7px 10px;background:#fff;border-bottom:1px solid #f2f2f2;',
    '  cursor:grab;transition:background .15s,opacity .15s}',
    '.frag:last-child{border-bottom:0}',
    '.frag:hover{background:#fafafa}',
    '.frag.dragging{opacity:.4;background:#fff6f6}',
    '.grip{color:#c8c8c8;font-size:13px;letter-spacing:-2px;user-select:none;cursor:grab;flex:none}',
    '.fname{font-size:13px;color:#333;flex:none;min-width:56px}',
    '.ftext{flex:1;min-width:0;height:26px;border:1px solid #e8e8e8;border-radius:6px;padding:0 7px;font-size:12px;',
    '  color:#555;outline:none;cursor:text;transition:border-color .18s}',
    '.ftext:focus{border-color:#ec4141}',
    '.del{width:22px;height:22px;border:0;background:transparent;border-radius:5px;color:#bbb;cursor:pointer;',
    '  font-size:15px;line-height:1;flex:none;transition:all .15s}',
    '.del:hover{background:#fdecec;color:#ec4141}',
    '.addrow{display:flex;gap:8px;margin-top:8px}',
    '.addrow select{flex:1}',
    '.txt{width:100%;height:34px;border:1px solid #e5e5e5;border-radius:7px;padding:0 8px;font-size:13px;',
    '  color:#333;outline:none;margin-top:8px;transition:border-color .18s}',
    '.txt:focus{border-color:#ec4141}',
    '.ptbox{margin-top:6px;padding:7px 10px;border-radius:7px;background:#fff;border:1px solid #eee;',
    '  font-size:12px;color:#444;word-break:break-all}',
    '.ft{padding:10px 18px 16px;display:flex;gap:10px;justify-content:flex-end;position:sticky;bottom:0;background:#fff;border-radius:0 0 12px 12px}',
    '.btn{height:34px;padding:0 16px;border-radius:8px;border:1px solid transparent;font-size:13px;cursor:pointer;transition:all .18s}',
    '.btn.primary{background:#ec4141;color:#fff}',
    '.btn.primary:hover{background:#d73535}',
    '.btn.ghost{background:#fff;color:#666;border-color:#e5e5e5}',
    '.btn.ghost:hover{background:#f7f7f7;color:#333}',
    '.btn.mini{height:34px;padding:0 14px;background:#f5f5f5;color:#444;border-color:#ececec}',
    '.btn.mini:hover{background:#ececec}',
    '.diag{margin:14px 0 6px;padding:11px 12px;border-radius:9px;background:#fbfbfb;border:1px solid #f0f0f0}',
    '.dbox{margin-top:6px;font-size:12px;color:#555;line-height:1.8;word-break:break-all}',
    '.tip{margin-top:10px;font-size:12px;color:#aaa;line-height:1.55}',
    '.hint{margin:-2px 0 2px;padding-left:2px;font-size:11.5px;color:#bbb;line-height:1.6}'
  ].join('\n');

  const HTML = [
    '<div class="mask" data-role="mask">',
    '  <div class="card">',
    '    <div class="hd"><span>网易云音乐设置增强 NCMWSE</span><button class="x" data-role="close" title="关闭">&times;</button></div>',
    '    <div class="bd">',
    '      <label class="row"><span>启用显示增强</span><input class="sw" type="checkbox" data-k="enabled"></label>',
    '      <label class="row"><span>显示右下角设置按钮</span><input class="sw" type="checkbox" data-k="showFab"></label>',
    '      <label class="row"><span>显示专辑封面</span><input class="sw" type="checkbox" data-k="showArtwork"></label>',
    '',
    '      <div class="sep"></div>',
    '      <div class="sect">系统媒体（SMTC）</div>',
    '      <div class="glabel">快速预设</div>',
    '      <div class="presets" data-role="presetsSmtc"></div>',
    '      <div data-role="smtcMods"></div>',
    '      <div class="glabel">片段连接符（三栏共用）</div>',
    '      <select data-k="smtcSep">',
    '        <option value=" - ">空格 - 空格</option>',
    '        <option value=" · ">· 间隔点</option>',
    '        <option value=" | ">| 竖线</option>',
    '        <option value="">（无分隔）</option>',
    '        <option value="__custom__">自定义…</option>',
    '      </select>',
    '      <input class="txt" data-role="smtcSepCustom" style="display:none" placeholder="输入自定义连接符，例如  ——  ">',
    '      <div class="collapse" data-role="transRow">',
    '        <label class="row" style="padding-top:10px"><span>启用翻译?（系统媒体）</span><input class="sw" type="checkbox" data-k="showTranslation"></label>',
    '        <div class="hint">译文按时间戳与本句原文配对：只有本句确实有译文时才显示，中英夹杂的歌曲唱到无译文的那句不会沿用上一句。只影响系统媒体/SMTC。</div>',
    '      </div>',
    '      <div class="preview">',
    '        <div class="plabel">实时预览 · 系统媒体卡片</div>',
    '        <div class="pbox">',
    '          <div class="ptitle" data-role="pv1">—</div>',
    '          <div class="partist" data-role="pv2">—</div>',
    '          <div class="palbum" data-role="pv3">—</div>',
    '        </div>',
    '      </div>',
    '',
    '      <div class="sep"></div>',
    '      <div class="sect">网页标题</div>',
    '      <label class="row"><span>自定义网页标题</span><input class="sw" type="checkbox" data-k="titleEnabled"></label>',
    '      <div class="glabel">快速预设</div>',
    '      <div class="presets" data-role="presetsTitle"></div>',
    '      <div class="mhd"><span>标题栏</span><span class="mhint">按住拖动排序，点 × 删除</span></div>',
    '      <div class="frags" data-role="frags_pageTitle"></div>',
    '      <div class="addrow">',
    '        <select data-role="addsel_pageTitle"></select>',
    '        <button class="btn mini" data-role="addbtn_pageTitle">添加片段</button>',
    '      </div>',
    '      <label class="row" style="margin-top:10px"><span>启用翻译?（网页标题）</span><input class="sw" type="checkbox" data-k="titleTrans"></label>',
    '      <div class="hint" style="margin-bottom:6px">只影响网页标题里的「歌词」片段，与系统媒体那个开关相互独立。</div>',
    '      <div class="glabel">片段连接符</div>',
    '      <select data-k="titleSep">',
    '        <option value=" - ">空格 - 空格</option>',
    '        <option value=" · ">· 间隔点</option>',
    '        <option value=" | ">| 竖线</option>',
    '        <option value="">（无分隔）</option>',
    '        <option value="__custom__">自定义…</option>',
    '      </select>',
    '      <input class="txt" data-role="sepCustom" style="display:none" placeholder="输入自定义连接符，例如  ——  ">',
    '      <div class="preview">',
    '        <div class="plabel">网页标题预览</div>',
    '        <div class="ptbox" data-role="ptitle">—</div>',
    '      </div>',
    '',
    '      <div class="diag">',
    '        <div class="plabel">诊断信息（歌词不显示时看这里）</div>',
    '        <div class="dbox" data-role="diag">—</div>',
    '      </div>',
    '      <div class="tip">入口：页面右下角齿轮按钮 · 快捷键 Ctrl+Alt+S · 脚本管理器菜单「显示设置」。<br>提示：需要页面处于播放状态，系统媒体控制才会出现。</div>',
    '    </div>',
    '    <div class="ft">',
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
    if (k === 'titleTrans') return draft.titleCfg.showTranslation;
    if (k === 'titleSep') return draft.titleCfg.sep;
    if (k === 'smtcSep') return draft.smtc.sep;
    return draft[k];
  }

  function keySet(k, v) {
    if (!draft) return;
    if (k === 'titleEnabled') draft.titleCfg.enabled = v;
    else if (k === 'titleTrans') draft.titleCfg.showTranslation = v;
    else if (k === 'titleSep') draft.titleCfg.sep = v;
    else if (k === 'smtcSep') draft.smtc.sep = v;
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
      row.className = 'frag';
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
        inp.placeholder = meta.def || '';
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
    draft.smtc.sep = ps.sep;
    draft.smtc.title = partsOf(ps.title);
    draft.smtc.artist = partsOf(ps.artist);
    draft.smtc.album = partsOf(ps.album);
    draft.showTranslation = !!ps.trans;
    fillPanel();
    refreshPreview();
  }

  function applyTitlePreset(ps) {
    if (!draft) return;
    draft.titleCfg.enabled = true;
    draft.titleCfg.sep = ps.sep;
    draft.titleCfg.parts = partsOf(ps.parts);
    draft.titleCfg.showTranslation = !!ps.trans;
    fillPanel();
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
      pv1: shadow.querySelector('[data-role="pv1"]'),
      pv2: shadow.querySelector('[data-role="pv2"]'),
      pv3: shadow.querySelector('[data-role="pv3"]'),
      ptitle: shadow.querySelector('[data-role="ptitle"]'),
      sepCustom: shadow.querySelector('[data-role="sepCustom"]'),
      smtcSepCustom: shadow.querySelector('[data-role="smtcSepCustom"]'),
      transRow: shadow.querySelector('[data-role="transRow"]'),
      diag: shadow.querySelector('[data-role="diag"]'),
      presetsSmtc: shadow.querySelector('[data-role="presetsSmtc"]'),
      presetsTitle: shadow.querySelector('[data-role="presetsTitle"]'),
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
          refreshPreview();
        });
      }
    });

    renderPresets(els.presetsSmtc, SMTC_PRESETS, applySmtcPreset);
    renderPresets(els.presetsTitle, TITLE_PRESETS, applyTitlePreset);

    els.mask.addEventListener('click', function (e) {
      if (e.target === els.mask || (e.target.getAttribute && e.target.getAttribute('data-role') === 'close')) closePanel();
    });

    els.ioMask.addEventListener('click', function (e) {
      if (e.target === els.ioMask) closeIO();
    });

    Array.prototype.forEach.call(els.inputs, function (el) {
      el.addEventListener('change', function () {
        const k = el.getAttribute('data-k');
        if (k === 'titleSep' || k === 'smtcSep') {
          const custom = (k === 'titleSep') ? els.sepCustom : els.smtcSepCustom;
          if (el.value === '__custom__') {
            custom.style.display = '';
            keySet(k, custom.value || ' - ');
          } else {
            custom.style.display = 'none';
            keySet(k, el.value);
          }
        } else {
          keySet(k, (el.type === 'checkbox') ? el.checked : el.value);
        }
        if (k === 'showTranslation') updateTransVisibility();
        refreshPreview();
      });
    });

    els.sepCustom.addEventListener('input', function () {
      keySet('titleSep', els.sepCustom.value);
      refreshPreview();
    });

    els.smtcSepCustom.addEventListener('input', function () {
      keySet('smtcSep', els.smtcSepCustom.value);
      refreshPreview();
    });

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
  }

  function fillPanel() {
    if (!els || !draft) return;
    Array.prototype.forEach.call(els.inputs, function (el) {
      const k = el.getAttribute('data-k');
      if (k === 'titleSep' || k === 'smtcSep') {
        const isTitle = (k === 'titleSep');
        const sep = isTitle ? draft.titleCfg.sep : draft.smtc.sep;
        const custom = isTitle ? els.sepCustom : els.smtcSepCustom;
        if (SEP_PRESETS.indexOf(sep) >= 0) {
          el.value = sep;
          custom.style.display = 'none';
        } else {
          el.value = '__custom__';
          custom.style.display = '';
          custom.value = sep;
        }
        return;
      }
      const v = keyGet(k);
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v;
    });
    renderMods();
    updateTransVisibility();
  }

  function hasLyricPart(arr) {
    return (arr || []).some(function (p) { return p && p.type === 'lyric'; });
  }

  // 「启用翻译?（系统媒体）」只在 SMTC 有哪一栏用到「歌词」片段时才展示
  function updateTransVisibility() {
    if (!els || !els.transRow || !draft) return;
    const s = draft.smtc || {};
    const show = hasLyricPart(s.title) || hasLyricPart(s.artist) || hasLyricPart(s.album);
    els.transRow.classList.toggle('show', show);
  }

  function fillPreview(info, c) {
    const meta = composeSmtc(info, c);
    els.pv1.textContent = meta.title || '—';
    els.pv2.textContent = meta.artist || '—';
    els.pv3.textContent = meta.album || '—';
    els.ptitle.textContent = composeTitle(info, c.titleCfg) || '—';
  }

  function refreshPreview() {
    if (!els || !draft) return;
    fillPreview(lastInfo || { song: '', artist: '', album: '', lyric: '', lyricTrans: '' }, draft);
  }

  function updatePreview(info) {
    if (!els || !host || host.style.display === 'none' || !draft) return;
    fillPreview(info, draft);
    updateDiag();
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
    requestAnimationFrame(function () { els.mask.classList.add('show'); });
  }

  function closePanel() {
    if (!host) return;
    els.mask.classList.remove('show');
    setTimeout(function () { if (host) host.style.display = 'none'; }, 180);
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
