/**
 * 星恬的小站 · Service Worker 离线缓存层
 *
 * 策略（按资源类型区分，不是一刀切）：
 *   · 页面导航（HTML）→ Stale-While-Revalidate：立刻回缓存、后台拉新版
 *     代价是可能看到「上一次发布」的版本，所以主页有「新版本可用」提示条
 *   · 静态资源（图标/图片/字体）→ Cache-First + 后台更新
 *   · 跨域请求（api.startian.top 等）→ 完全不拦截，交给浏览器
 *
 * 为什么 HTML 不用 Network-First：主页混淆版 3.2MB，每次都拉要等 7 秒，
 * 那样 SW 就失去意义了。SWR 是「速度」与「时效」的折中。
 *
 * 版本号由发布脚本注入（占位 20261025-2119），每次发布换新值 → 触发更新。
 */
'use strict';

var VER = '20261025-2119';
var CACHE = 'startian-' + VER;
var CACHE_PREFIX = 'startian-';

/* 预缓存：只放体积小、几乎不变的品牌资源。
   大图（demos 缩略图）走「访问过才缓存」，避免首次安装就下几十 MB */
var PRECACHE = [
  '/avatar.png',
  '/favicon.ico'
];

self.addEventListener('install', function (e) {
  self.skipWaiting();               // 新 SW 立即进入 waiting → activate
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // 单个资源失败不能拖垮整个安装
      return Promise.all(PRECACHE.map(function (u) {
        return c.add(u).catch(function () {});
      }));
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        // 只清自己的旧版本，别碰同域其他站的缓存
        if (k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE) return caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();   // 立即接管已打开的页面
    })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;

  // 只处理 GET；POST（留言）不拦
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }

  // 跨域一律放行（api.startian.top / 外部 CDN 等）
  if (url.origin !== self.location.origin) return;

  // 带 ?nosw=1 的请求绕过缓存（调试逃生口）
  if (url.search.indexOf('nosw=1') >= 0) return;

  var isDoc = req.mode === 'navigate';
  e.respondWith(isDoc ? handleDoc(e, req) : handleAsset(e, req));
});

/* 页面导航：有缓存先给，同时后台更新
   ⚠ 必须按 pathname 分开存 —— 这个 SW 的 scope 是 /，同时服务主页和十几个子站，
   如果都用 '/index.html' 当 key，访问 /wuziqi/ 就会把主页缓存覆盖掉 */
function handleDoc(e, req) {
  var KEY = '/index.html';
  try {
    var p = new URL(req.url).pathname;
    if (p && p !== '/') KEY = p;
  } catch (err) {}
  return caches.open(CACHE).then(function (cache) {
    return cache.match(KEY).then(function (cached) {
      var network = fetch(req).then(function (res) {
        if (res && res.ok) cache.put(KEY, res.clone());
        return res;
      }).catch(function () { return null; });

      if (cached) {
        e.waitUntil(network);          // 后台静默更新，不阻塞首屏
        return cached;
      }
      return network.then(function (res) {
        return res || offlinePage();
      });
    });
  });
}

/* 静态资源：命中就直接返回，顺手后台校验一次 */
function handleAsset(e, req) {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(req).then(function (cached) {
      if (cached) {
        e.waitUntil(
          fetch(req).then(function (res) {
            if (res && res.ok) cache.put(req, res.clone());
          }).catch(function () {})
        );
        return cached;
      }
      return fetch(req).then(function (res) {
        // 只缓存同源 basic 响应；CF 注入的 /cdn-cgi/* 这类不缓存
        if (res && res.ok && res.type === 'basic' &&
            new URL(req.url).pathname.indexOf('/cdn-cgi/') !== 0) {
          cache.put(req, res.clone()).catch(function () {});
        }
        return res;
      }).catch(function () {
        return new Response('', { status: 504, statusText: 'Offline' });
      });
    });
  });
}

function offlinePage() {
  var html = '<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>离线</title>' +
    '<div style="min-height:100vh;display:grid;place-items:center;font:16px/1.8 system-ui;background:#eef8ff;color:#1f3c5e;text-align:center;padding:24px">' +
    '<div><div style="font-size:44px;margin-bottom:14px">🌙</div>' +
    '<div style="font-size:18px;font-weight:800;margin-bottom:8px">现在没有网络</div>' +
    '<div style="color:#54759a;font-size:13.5px">这个页面还没被缓存过，联网后再打开一次就能离线看了</div>' +
    '<div style="margin-top:18px"><button onclick="location.reload()" style="padding:10px 22px;border-radius:10px;border:1px solid #c9e2fa;background:#fff;color:#3f86d1;font-weight:700;cursor:pointer">重试</button></div>' +
    '</div></div>';
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html;charset=utf-8' }
  });
}

/* 让页面可以主动查询/清理缓存 */
self.addEventListener('message', function (e) {
  var d = e.data || {};
  if (d.type === 'SKIP_WAITING') self.skipWaiting();
  if (d.type === 'CLEAR_CACHE') {
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k.indexOf(CACHE_PREFIX) === 0) return caches.delete(k);
      }));
    }).then(function () {
      if (e.source) e.source.postMessage({ type: 'CACHE_CLEARED' });
    });
  }
});
