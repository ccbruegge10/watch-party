/*
 * Watch Party: a synced video screen for SideQuest / Banter worlds, as a snippet.
 *
 *   <bs-snippet name="watch-party" script="https://YOUR-HOST/watch-party.js" ...settings...>
 *
 * - One host; everyone else's screen follows theirs, and latecomers jump to the same moment.
 *   Host order: the world owner when present, otherwise whoever has been here longest.
 * - YouTube plays in YouTube's own player (player.html, hosted next to this file), full screen.
 * - Control bar under the screen; a Playlist panel beside it (Queue / Search / People).
 * - Shared queue that plays on by itself, Lock (host only), Take host / Make host.
 * - Each person's own volume, fading with distance from the screen.
 * - When someone arrives to an empty world, the old video and queue are cleared.
 * Settings are the element's attributes; see the snippet definition for the list.
 */
(() => {
  // ---------- Settings (read from the <bs-snippet name="watch-party"> element) ----------
  const EL = document.querySelector('bs-snippet[name="watch-party"]');
  if (!EL) { console.warn("[Watch party] no <bs-snippet name=\"watch-party\"> on the page"); return; }
  const attr = (n, d) => { const v = EL.getAttribute(n); return v === null || v === "" ? d : v; };
  const num = (n, d, lo, hi) => { const v = parseFloat(attr(n, "")); return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
  const bool = (n, d) => { const v = String(attr(n, "")).toLowerCase(); return v === "true" ? true : v === "false" ? false : d; };
  const vec3 = (n, d) => { const a = String(attr(n, "")).trim().split(/\s+/).map(Number); return a.length === 3 && a.every(isFinite) ? a : d; };
  const POS = vec3("position", [0, 2, 3]), ROT = vec3("rotation", [0, 0, 0]);
  const WIDTH = num("width", 4, 0.5, 20);                                  // metres
  const fullAt = num("full-volume-distance", 5, 0, 500);
  const WP = {
    fallback: POS,
    idleText: String(attr("idle-text", "Open Playlist and pick something to watch")).slice(0, 120),
    skipAds: bool("skip-ads", true),
    pageW: 1920, pageH: 1080,
    idleW: 480, idleH: 270,
    scale: WIDTH / (1920 / 1300),
    barWidth: num("control-width", 1.2, 0.3, 5),
    panelWidth: num("panel-width", 1.6, 0.5, 5),
    panelGap: 0.15,
    panelY: num("panel-height", -0.9, -10, 10),
    key: String(attr("channel", "wp")).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16) || "wp",
    drift: num("sync-tolerance", 2.5, 0.5, 10),
    startVolume: num("volume", 30, 0, 100) / 100,
    hostLabelAbove: num("host-label-height", 0.3, 0, 3),
    fullVolumeWithin: fullAt, silentBeyond: Math.max(fullAt + 0.5, num("silence-distance", 12, 0, 1000)), fadeCurve: 2,
    distanceVolume: bool("distance-volume", true),
    showDistance: bool("debug", false),
    maxQueue: num("max-items", 50, 1, 100),
    searchResults: 12,
  };
  // Colours (the snippet's palette)
  const C = {
    bg: "rgba(35,35,39,0.97)", bgSolid: "#1d1d21", panel: "rgba(43,43,47,0.98)", row: "#34343a",
    button: "#3a3a40", accent: "#1f9a9e", danger: "#e05555", text: "#f4f4f6", dim: "#a9a9b1",
    muted: "#707078", live: "#e0364b", chip: "#141418", outline: "#e8e8ec", activeRow: "rgba(31,154,158,0.30)",
  };
  // ------------------------------

  // The black screen shown when nothing's playing (no web page, nothing to click)
  const IDLE = "data:text/html;charset=utf-8," + encodeURIComponent(
    "<html><body style='margin:0;background:#000;color:#8a8a92;font:42px sans-serif;display:flex;align-items:center;justify-content:center;height:100vh'>" +
    WP.idleText + "</body></html>");
  const isIdle = (u) => !u || /^data:|^about:/i.test(u);
  // YouTube plays in a small player page (player.html, hosted next to this script) using YouTube's own
  // player API. If it can't be reached, a screen falls back to opening YouTube's embed page directly.
  const SCRIPT_SRC = (document.currentScript && document.currentScript.src) ||
    ([...document.scripts].map((s) => s.src).find((s) => /watch-party(\.min)?\.js(\?|$)/.test(s)) || "");
  let PLAYER_BASE = attr("player", "") || (SCRIPT_SRC ? new URL("player.html", SCRIPT_SRC).href : "");
  if (!/^https?:\/\//i.test(PLAYER_BASE)) PLAYER_BASE = null;
  console.log("[Watch party] " + (PLAYER_BASE ? "using the player page " + PLAYER_BASE : "no player page; using YouTube's embed page"));
  const K = { url: WP.key + "_url", host: WP.key + "_host", lock: WP.key + "_lock", queue: WP.key + "_queue", hist: WP.key + "_hist",
              join: WP.key + "_join_", owner: WP.key + "_owner" };

  // Put into the screen's page: once a second it tells the world the address and where the video is
  const PAGE_WATCH =
    "(function(){if(window.__bsWp||window.__WP_PLAYER)return;window.__bsWp=true;" +
    "function vid(){var b=null;document.querySelectorAll('video').forEach(function(v){if(!b||(v.duration||0)>(b.duration||0))b=v;});return b;}" +
    "window.__bsSeek=function(t){var v=vid();if(v&&isFinite(t))v.currentTime=Math.max(0,t);};" +
    "window.__bsPlay=function(on){var v=vid();if(!v)return;try{if(on){var p=v.play();if(p&&p.catch)p.catch(function(){});}else v.pause();}catch(e){}};" +
    // volume glides to the target the world sends, and stays there
    "var vT=null,vN=null;window.__bsVol=function(x){if(isFinite(x))vT=Math.max(0,Math.min(1,x));};" +
    "setInterval(function(){if(vT===null)return;if(vN===null)vN=vT;vN+=(vT-vN)*0.15;if(Math.abs(vT-vN)<0.004)vN=vT;" +
    "document.querySelectorAll('video,audio').forEach(function(m){if(Math.abs(m.volume-vN)>0.003)m.volume=vN;});},50);" +
    "function send(){try{if(window.O&&typeof window.O.sendMessage==='function'){var v=vid();" +
    "window.O.sendMessage('app',JSON.stringify({from:'wp',url:location.href,title:document.title,t:v?v.currentTime:null,paused:v?v.paused:null," +
    "d:v?v.duration:null,ended:v?v.ended:false,err:!!document.querySelector('.ytp-error')," +
    "ad:!!document.querySelector('.ad-showing,.ad-interrupting')}));}}catch(e){}}" +
    // on a normal YouTube video page, stretch the player over the whole page
    "function fill(){if(!/youtube\\.com$/.test(location.hostname)||location.pathname!=='/watch'||document.getElementById('__bsFill'))return;" +
    "var st=document.createElement('style');st.id='__bsFill';st.textContent='#movie_player,#player-container,#ytd-player,.html5-video-container{position:fixed!important;" +
    "left:0!important;top:0!important;width:100vw!important;height:100vh!important;z-index:2147483646!important;background:#000!important}" +
    "video.html5-main-video{left:0!important;top:0!important;width:100vw!important;height:100vh!important;object-fit:contain!important}" +
    "html,body{overflow:hidden!important}';document.head.appendChild(st);window.dispatchEvent(new Event('resize'));}" +
    // ads: mute them, jump to their end and press Skip; sound back on after
    (WP.skipAds ? "var adMuted=false;function ads(){var on=!!document.querySelector('.ad-showing,.ad-interrupting');var v=vid();" +
    "if(on&&v){if(!v.muted){v.muted=true;adMuted=true;}if(isFinite(v.duration)&&v.duration>0&&v.currentTime<v.duration-0.3)v.currentTime=v.duration-0.1;}" +
    "if(on){var b=document.querySelector('.ytp-ad-skip-button,.ytp-ad-skip-button-modern,.ytp-skip-ad-button,.videoAdUiSkipButton,button[id^=skip-button]');if(b)b.click();}" +
    "if(!on&&adMuted&&v){v.muted=false;adMuted=false;}" +
    "var o=document.querySelector('.ytp-ad-overlay-close-button');if(o)o.click();}setInterval(ads,250);" : "") +
    "send();setInterval(function(){send();fill();},1000);})();";
  // Put into the hidden search page: reads the results YouTube put in the page and sends them to the world
  const SEARCH_READ =
    "(function(){if(window.__bsScr)return;var q=new URLSearchParams(location.search).get('search_query');" +
    "if(!q||!window.ytInitialData||!window.O||typeof window.O.sendMessage!=='function')return;" +
    "var out=[];function txt(t){return t?(t.simpleText||(t.runs||[]).map(function(r){return r.text;}).join('')):'';}" +
    "function walk(o,d){if(!o||typeof o!=='object'||out.length>=" + WP.searchResults + "||d>40)return;" +
    "if(o.videoRenderer&&o.videoRenderer.videoId){var v=o.videoRenderer;out.push({id:v.videoId,title:txt(v.title),d:txt(v.lengthText)," +
    "live:!v.lengthText&&/LIVE/.test(JSON.stringify(v.badges||[])+JSON.stringify(v.thumbnailOverlays||[]))});return;}" +
    "for(var k in o)walk(o[k],d+1);}walk(window.ytInitialData,0);" +
    "window.O.sendMessage('app',JSON.stringify({from:'wpq',q:q,items:out}));window.__bsScr=true;})();";

  // Put into the hidden page for a playlist: reads the playlist's videos and sends them to the world
  const PLAYLIST_READ =
    "(function(){if(window.__bsPl)return;var l=new URLSearchParams(location.search).get('list');" +
    "if(!l||!window.ytInitialData||!window.O||typeof window.O.sendMessage!=='function')return;" +
    "var out=[],seen={},title='';function txt(t){return t?(t.simpleText||t.content||(t.runs||[]).map(function(r){return r.text;}).join('')):'';}" +
    "function walk(o,d){if(!o||typeof o!=='object'||out.length>=200||d>60)return;" +
    "var v=o.playlistVideoRenderer||o.playlistPanelVideoRenderer;" +
    "if(v&&v.videoId){if(!seen[v.videoId]){seen[v.videoId]=1;out.push({id:v.videoId,title:txt(v.title),d:txt(v.lengthText)});}return;}" +
    "if(!title&&o.playlistHeaderRenderer)title=txt(o.playlistHeaderRenderer.title);" +
    "if(!title&&o.playlist&&o.playlist.title&&typeof o.playlist.title!=='string')title=txt(o.playlist.title);" +
    "for(var k in o)walk(o[k],d+1);}walk(window.ytInitialData,0);" +
    "if(!title)title=document.title.replace(/ - YouTube$/,'');" +
    "window.O.sendMessage('app',JSON.stringify({from:'wpl',list:l,title:title,items:out}));window.__bsPl=true;})();";

  // Two addresses for the same thing (YouTube adds bits to its addresses after a video loads)
  const norm = (u) => {
    try {
      const x = new URL(u); x.hash = "";
      const host = x.hostname.replace(/^(www|m)\./, "");
      if ((host === "youtube.com" || host === "youtube-nocookie.com") && x.pathname === "/watch") return "yt:" + x.searchParams.get("v");
      const em = x.pathname.match(/^\/(embed|shorts|live)\/([\w-]{11})/);
      if ((host === "youtube.com" || host === "youtube-nocookie.com") && em) return "yt:" + em[2];
      if (host === "youtu.be") return "yt:" + x.pathname.slice(1, 12);
      return x.origin + x.pathname.replace(/\/$/, "") + x.search;
    } catch (err) { return String(u || ""); }
  };
  const sameUrl = (a, b) => norm(a) === norm(b);
  const ytId = (u) => { const n = norm(u); return /^yt:[\w-]{11}$/.test(n) ? n.slice(3) : null; };
  const isEmbed = (u) => /youtube(-nocookie)?\.com\/embed\//i.test(u || "");
  const embedUrl = (id) => "https://www.youtube.com/embed/" + id + "?autoplay=1&playsinline=1&rel=0&modestbranding=1&iv_load_policy=3";
  const watchUrl = (id) => "https://www.youtube.com/watch?v=" + id;
  const looksLikeAddress = (s) => /^https?:\/\//i.test(s) || (!/\s/.test(s) && /^[\w-]+(\.[\w-]+)+(\/|$|\?)/.test(s));
  const isVideoPage = (u) => /^yt:/.test(norm(u)) || /twitch\.tv\/(videos\/)?[^/]+$/i.test(u || "") || /\.(mp4|webm|m3u8)(\?|$)/i.test(u || "");
  const badgeOf = (u, live) => live ? "LIVE" : ytId(u) ? "YT" : /twitch\.tv/i.test(u || "") ? "TWITCH" : /\.m3u8(\?|$)/i.test(u || "") ? "HLS" : /\.(mp4|webm)(\?|$)/i.test(u || "") ? "FILE" : "LINK";
  const thumbOf = (u) => { const id = ytId(u); return id ? "https://i.ytimg.com/vi/" + id + "/mqdefault.jpg" : null; };
  const cleanTitle = (t) => String(t || "").replace(/ - YouTube$/, "").trim();
  const cut = (t, n) => { t = String(t || ""); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
  const fmt = (s) => {
    if (typeof s !== "number" || !isFinite(s) || s < 0) return "--:--";
    s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0");
  };

  window.addEventListener("bs-loaded", () => {
    const scene = BS.Scene.GetInstance();
    const me = () => (scene.localUser ? scene.localUser.uid : "me");
    const nameOf = (uid) => { const u = (scene.users || {})[uid]; return (u && u.name) || "someone"; };
    const share = (props) => scene.SetPublicSpaceProps(props);

    let browser = null, currentUrl = null, pendingUrl = null, settleUntil = 0;
    let host = null, locked = false, queue = [], hist = [];
    let arrived = false, waitingUrl = null;    // what was playing when I arrived, held until I know whether anyone's here
    let override = "", lockUid = "", ownerUid = "", joinedAt = Date.now(), myStampWritten = false, ownerClaimed = false;
    const joins = {};          // uid -> when they arrived (their place in line for host)
    const staleJoin = {};      // uid -> an old arrival time left over from an earlier visit (ignored)
    let lastQ = "";
    let master = null, page = null, lastSent = 0, quietUntil = 0, lastEndedUrl = null;
    let refreshUi = () => {}, refreshLabel = () => {};
    const isHost = () => host === me();
    const hostHere = () => !!(host && (scene.users || {})[host]);
    const canControl = () => !locked || isHost();
    let sayUntil = 0, sayText = "";
    function say(t) { sayText = t; sayUntil = Date.now() + 3500; refreshUi(); setTimeout(() => refreshUi(), 3600); }
    const blocked = () => { if (canControl()) return false; say("Locked: only the host can control"); return true; };

    // ---------- Pages ----------
    function runInPage(code) { if (browser) browser.RunActions(JSON.stringify({ actions: [{ actionType: "runscript", strParam1: code }] })); }

    const noEmbed = new Set();                    // videos the embed player refused on this screen
    function screenUrlFor(url) {                  // YouTube videos play in the full-screen embed player
      const id = ytId(url);
      if (!id) return url;
      return noEmbed.has(id) ? watchUrl(id) : embedUrl(id);
    }
    function pageFor(url) {                       // what the screen's browser actually opens
      if (PLAYER_BASE && !playerBroken) {
        if (isIdle(url)) return PLAYER_BASE + "#wpplayer&idle=" + encodeURIComponent(WP.idleText);
        const id = ytId(url);
        if (id && !noEmbed.has(id)) return PLAYER_BASE + "#wpplayer=" + id;
      }
      return url;
    }
    // If the built-in player page never answers on this computer (some platforms can't open it),
    // this screen goes back to opening YouTube's embed page directly. Only affects this player.
    let playerBroken = false, playerOk = false, playerOpenedAt = 0;
    setInterval(() => {
      if (!PLAYER_BASE || playerBroken || playerOk || !playerOpenedAt || Date.now() - playerOpenedAt < 15000) return;
      playerBroken = true;
      console.log("[Watch party] the built-in player page didn't load here; using YouTube's embed page instead");
      if (currentUrl) showUrl(currentUrl, true);
    }, 2000);
    function showUrl(url, force) {                // this player's screen only
      if (!url) return;
      url = screenUrlFor(url);
      if (!force && (url === currentUrl || sameUrl(url, currentUrl))) return;
      currentUrl = url;
      page = null;
      settleUntil = Date.now() + 6000;
      const pageUrl = pageFor(url);
      if (PLAYER_BASE && !playerOk && pageUrl.indexOf(PLAYER_BASE) === 0 && !playerOpenedAt) playerOpenedAt = Date.now();
      setPageSize(url);
      if (browser) browser.url = pageUrl; else pendingUrl = pageUrl;
      refreshUi();
    }
    let pageSize = "";
    function setPageSize(url) {                   // small while idle, full size for a video
      if (!browser) return;
      const idle = isIdle(url), key = idle ? "idle" : "full";
      if (key === pageSize) return;
      pageSize = key;
      try { browser.pageWidth = idle ? WP.idleW : WP.pageW; browser.pageHeight = idle ? WP.idleH : WP.pageH; } catch (err) {}
    }
    function play(raw, fromHistory) {             // everyone's screen
      let url = (raw || "").trim();
      if (!url) return;
      if (!/^https?:\/\//i.test(url) && !isIdle(url)) url = "https://" + url;
      if (blocked()) return;
      const id = ytId(url);
      if (id) url = embedUrl(id);
      if (!isVideoPage(url) && !isIdle(url)) { say("That isn't a video link"); return; }
      if (!fromHistory && currentUrl && isVideoPage(currentUrl) && !sameUrl(currentUrl, url)) {
        hist = hist.filter((h) => !sameUrl(h, currentUrl)).concat([currentUrl]).slice(-10);
        share({ [K.hist]: encodeURIComponent(JSON.stringify(hist)) });
      }
      showUrl(url);
      share({ [K.url]: encodeURIComponent(url) });
    }

    // ---------- Host ----------
    // Who's host, worked out the same way on every player (nothing to argue about):
    //   1. someone handed it to with Take host / Make host, while they're here
    //   2. otherwise the world's owner, while they're here
    //   3. otherwise whoever has been here longest, then the next longest, and so on
    const here = (uid) => !!(uid && (scene.users || {})[uid]);
    const presentWhenIArrived = new Set();
    const placeInLine = (uid) => {
      if (uid === me()) return myStampWritten ? joins[uid] : Infinity;
      const t = joins[uid];
      if (t && t !== staleJoin[uid]) return t;
      // No arrival time from them (yet): anyone who was already here before me counts as ahead of me,
      // so a newcomer never jumps the line just because a message hasn't reached them
      return !myStampWritten || presentWhenIArrived.has(uid) ? 0 : Infinity;
    };
    function recompute() {
      const users = scene.users || {};
      const uids = Object.keys(users);
      let h;
      if (here(override)) h = override;
      else if (here(ownerUid)) h = ownerUid;
      else if (!uids.length) h = me();
      else h = uids.slice().sort((a, b) => (placeInLine(a) - placeInLine(b)) || (a < b ? -1 : a > b ? 1 : 0))[0];
      const lk = !!(lockUid && lockUid === h && here(h));   // a lock belongs to the host who set it
      if (h !== host || lk !== locked) { host = h; locked = lk; refreshUi(); refreshLabel(); }
    }
    // Arriving: take my place at the back of the line, once I've seen everyone else's places
    setTimeout(() => {
      for (const uid of Object.keys(scene.users || {})) if (uid !== me()) presentWhenIArrived.add(uid);
      let latest = Date.now();
      for (const uid in joins) if (uid !== me() && here(uid) && placeInLine(uid) !== Infinity) latest = Math.max(latest, joins[uid] + 1);
      joins[me()] = latest; myStampWritten = true;
      // Nobody else here: the world was empty, so whatever was playing (and queued) when the last
      // person left is cleared, and the screen starts blank. Otherwise join in with what's on.
      arrived = true;
      const others = Object.keys(scene.users || {}).filter((u) => u !== me()).length;
      if (!others) {
        queue = []; hist = [];
        share({ [K.url]: encodeURIComponent(IDLE), [K.queue]: encodeURIComponent("[]"), [K.hist]: encodeURIComponent("[]"), [K.lock]: "" });
        showUrl(IDLE);
        refreshUi();
      } else if (waitingUrl) showUrl(waitingUrl);
      waitingUrl = null;
      share({ [K.join + me()]: String(latest) });
      if (override === me()) share({ [K.host]: "" });          // left over from an earlier visit
      findOwner();
      recompute();
    }, 3000);
    // Who owns the world. Only the owner can save the world's own files, so the owner's page saves its
    // id in one and everyone reads it from there (it's there even while the owner is away). The owner
    // also says so in a message the server marks as coming from the owner.
    const OWNER_FILE = "watchparty_owner";
    async function findOwner() {
      const P = BS.PersistFileBridge;
      if (!P) return;
      let saved = null;
      try { const t = await P.get(scene, OWNER_FILE); saved = t ? JSON.parse(t) : null; } catch (err) {}
      if (saved && typeof saved.uid === "string" && !ownerUid) { ownerUid = saved.uid; recompute(); }
      try {
        const info = await P.info(scene);
        if (!info || !info.canWrite) return;            // not the owner (or not signed in)
        ownerUid = me();
        iAmOwner();
        if (!saved || saved.uid !== me()) P.set(scene, OWNER_FILE, JSON.stringify({ uid: me() })).catch(() => {});
        try { scene.OneShot({ wp: WP.key, owner: me() }); } catch (err) {}
      } catch (err) {}
    }
    function iAmOwner() {
      if (ownerClaimed) return;
      ownerClaimed = true;
      if (override && override !== me()) share({ [K.host]: "" });   // the owner arriving takes over
      recompute();
    }
    function makeHost(uid) {
      if (locked && !isHost()) { say("Locked: only the host can hand it over"); return; }
      override = uid; share({ [K.host]: uid }); recompute();
    }
    function setLock(on) {
      if (!isHost()) { say("Only the host can lock"); return; }
      lockUid = on ? me() : ""; share({ [K.lock]: lockUid }); recompute();
    }
    setInterval(recompute, 1000);

    // ---------- Playback ----------
    function doPlayback(cmd, s) {
      if (cmd === "skip") runInPage("window.__bsSkip?window.__bsSkip(" + Number(s) + "):(function(){var v=document.querySelector('video');if(v)v.currentTime=Math.max(0,v.currentTime+(" + Number(s) + "));})()");
      if (cmd === "seekto") runInPage("window.__bsSeek&&window.__bsSeek(" + Number(s) + ")");
      if (cmd === "play") runInPage("window.__bsPlay&&window.__bsPlay(true)");
      if (cmd === "pause") runInPage("window.__bsPlay&&window.__bsPlay(false)");
    }
    function playback(cmd, s) {
      if (blocked()) return;
      quietUntil = Date.now() + 2500;
      doPlayback(cmd, s);
      scene.OneShot({ wp: WP.key, cmd, s: s || 0 });
      if (page && (cmd === "play" || cmd === "pause")) page.paused = cmd === "pause";
      refreshUi();
    }
    const togglePlay = () => playback(page && page.paused === false ? "pause" : "play");
    function playPrev() {
      if (blocked()) return;
      if (page && typeof page.t === "number" && page.t > 5) { playback("seekto", 0); return; }
      const prev = hist[hist.length - 1];
      if (!prev) { playback("seekto", 0); return; }
      hist = hist.slice(0, -1);
      share({ [K.hist]: encodeURIComponent(JSON.stringify(hist)) });
      play(prev, true);
    }

    // ---------- Queue ----------
    // The queue is stored short (YouTube videos as just their id) so a long playlist still fits
    const packQueue = (q) => q.map((x) => { const id = ytId(x.url); const o = { u: id ? "y:" + id : x.url, t: x.title || "" };
                                            if (x.d) o.d = x.d; if (x.live) o.l = 1; return o; });
    const unpackQueue = (q) => (Array.isArray(q) ? q : []).map((x) => x && x.u
      ? { url: /^y:/.test(x.u) ? embedUrl(x.u.slice(2)) : x.u, title: x.t || "", d: x.d || "", live: !!x.l }
      : x).filter((x) => x && x.url);
    function saveQueue() { share({ [K.queue]: encodeURIComponent(JSON.stringify(packQueue(queue))) }); refreshUi(); }
    function enqueue(item) {
      if (blocked()) return false;
      if (queue.some((q) => sameUrl(q.url, item.url))) { say("Already in the queue"); return false; }
      if (queue.length >= WP.maxQueue) { say("The queue is full"); return false; }
      queue.push({ url: item.url, title: cut(item.title, 70), d: item.d || "", live: !!item.live });
      saveQueue();
      say("Added");
      return true;
    }
    function playNext() {
      if (blocked() || !queue.length) return;
      const next = queue.shift();
      saveQueue();
      play(next.url);
    }
    function queueMove(i, by) {
      if (blocked()) return;
      const j = i + by;
      if (j < 0 || j >= queue.length) return;
      const t = queue[i]; queue[i] = queue[j]; queue[j] = t;
      saveQueue();
    }
    // A whole YouTube playlist: Play all = replace the queue and start the first; Add all = add to the end
    function importPlaylist(items, playNow) {
      if (blocked() || !items.length) return;
      const fresh = items.filter((it) => !sameUrl(it.url, currentUrl));
      if (playNow) {
        const [first, ...rest] = items;
        queue = rest.slice(0, WP.maxQueue).map((it) => ({ url: it.url, title: cut(it.title, 70), d: it.d || "", live: !!it.live }));
        saveQueue();
        play(first.url);
        say("Playing the playlist" + (items.length - 1 > WP.maxQueue ? " (first " + (WP.maxQueue + 1) + " videos)" : ""));
      } else {
        let added = 0;
        for (const it of fresh) {
          if (queue.length >= WP.maxQueue) break;
          if (queue.some((q) => sameUrl(q.url, it.url))) continue;
          queue.push({ url: it.url, title: cut(it.title, 70), d: it.d || "", live: !!it.live }); added++;
        }
        saveQueue();
        say("Added " + added + " of " + items.length + (added < fresh.length ? " (the queue is full)" : ""));
      }
    }
    function queueRemove(i) { if (blocked()) return; queue.splice(i, 1); saveQueue(); }
    function queuePlay(i) { if (blocked()) return; const it = queue.splice(i, 1)[0]; saveQueue(); if (it) play(it.url); }

    // ---------- Search (a hidden page reads YouTube's results) ----------
    let searchObj = null, searchBrowser = null, searchQuery = "", searchTimer = null, searchParent = null;
    let results = [], searchState = "";                // "", "searching", "done", "none"
    const pages = { queue: 0, search: 0 };
    async function runSearch(text) {
      text = (text || "").trim();
      if (!text) return;
      playlist = null;
      if (looksLikeAddress(text)) {                  // a link: offer it as the one result
        let url = /^https?:\/\//i.test(text) ? text : "https://" + text;
        let listId = null;
        try { const u = new URL(url); listId = /youtube\.com$|youtu\.be$/.test(u.hostname.replace(/^(www|m|music)\./, "")) ? u.searchParams.get("list") : null; } catch (err) {}
        if (listId && /^[\w-]{10,}$/.test(listId)) {   // a playlist: read its videos
          const v = ytId(url);
          const page = /^RD/.test(listId) && v ? "https://www.youtube.com/watch?v=" + v + "&list=" + listId   // a "Mix" only exists on a video page
                                               : "https://www.youtube.com/playlist?list=" + listId;
          return readPage(page, "list", listId);
        }
        const id = ytId(url);
        const item = { url: id ? embedUrl(id) : url, title: id ? "" : url, d: "" };
        results = [item]; searchState = "done"; refreshUi();
        if (id && scene.YtInfo) scene.YtInfo(id).then((info) => {
          const v = info && info.videoDetails; if (!v) return;
          item.title = v.title || ""; item.d = fmt(Number(v.lengthSeconds) || NaN); item.live = !!v.isLiveContent && !Number(v.lengthSeconds);
          refreshUi();
        }).catch(() => {});
        return;
      }
      return readPage("https://www.youtube.com/results?search_query=" + encodeURIComponent(text) + "&sp=EgIQAQ%253D%253D", "search", text);
    }
    // The hidden page that reads YouTube's results (a search, or a playlist's videos)
    let readKind = "search", playlist = null;
    async function readPage(url, kind, query) {
      searchQuery = query; readKind = kind; results = []; searchState = "searching"; pages.search = 0; refreshUi();
      if (!searchObj) {
        searchObj = new BS.GameObject({ name: "WatchPartySearchReader", localScale: new BS.Vector3(0.01, 0.01, 0.01), ...searchParent });
        searchBrowser = await searchObj.AddComponent(new BS.Browser({ url, pageWidth: 800, pageHeight: 600 }));
        searchObj.On("browser-message", (e) => {
          let m; try { m = JSON.parse(e.detail); } catch (err) { return; }
          if (!m || searchState !== "searching") return;
          if (m.from === "wpq" && readKind === "search" && m.q === searchQuery)
            results = (m.items || []).map((x) => ({ url: embedUrl(x.id), title: x.title, d: x.live ? "" : x.d, live: !!x.live }));
          else if (m.from === "wpl" && readKind === "list" && m.list === searchQuery) {
            results = (m.items || []).map((x) => ({ url: embedUrl(x.id), title: x.title, d: x.d || "" }));
            playlist = { title: m.title || "Playlist", count: results.length };
          } else return;
          searchState = results.length ? "done" : "none";
          closeReader();
          refreshUi();
        });
        readerTimer = setInterval(() => {
          if (searchState === "searching" && searchBrowser)
            searchBrowser.RunActions(JSON.stringify({ actions: [{ actionType: "runscript", strParam1: readKind === "list" ? PLAYLIST_READ : SEARCH_READ }] }));
        }, 700);
      } else searchBrowser.url = url;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { if (searchState === "searching") { searchState = "none"; closeReader(); refreshUi(); } }, 15000);
    }
    // The hidden search page is a whole web browser: close it once the results are in
    let readerTimer = null;
    function closeReader() {
      clearInterval(readerTimer); readerTimer = null;
      const o = searchObj;
      searchObj = null; searchBrowser = null;
      if (o) try { o.Destroy(); } catch (err) { try { o.SetActive(false); } catch (e2) {} }
    }

    // ---------- Shared values ----------
    const parseList = (v) => { try { return JSON.parse(decodeURIComponent(v || "")) || []; } catch (err) { return []; } };
    scene.On("space-state-changed", (e) => {
      for (const ch of e.detail.changes) {
        const v = ch.newValue;
        if (ch.property === K.url && v) {
          try { const u = decodeURIComponent(v); if (arrived) showUrl(u); else waitingUrl = u; } catch (err) {}   // see "Arriving" below
        }
        else if (ch.property === K.host) { override = v || ""; recompute(); }
        else if (ch.property === K.lock) { lockUid = v && v !== "0" && v !== "1" ? v : ""; recompute(); }
        // (an older version kept the owner in K.owner; that value isn't trusted any more)
        else if (ch.property && ch.property.indexOf(K.join) === 0) {
          const uid = ch.property.slice(K.join.length), t = Number(v);
          if (uid !== me() || myStampWritten) { joins[uid] = t; recompute(); }
        }
        else if (ch.property === K.queue) { queue = unpackQueue(parseList(v)); refreshUi(); }
        else if (ch.property === K.hist) { hist = parseList(v); }
      }
    });
    const uidOf = (e) => { const d = e && e.detail; return d && (d.uid || (d.user && d.user.uid)); };
    scene.On("user-left", (e) => {
      const uid = uidOf(e);
      if (uid && uid === override) { override = ""; share({ [K.host]: "" }); }   // the person handed host left: back to the line
      recompute();
    });
    scene.On("user-joined", (e) => {
      const uid = uidOf(e);
      if (uid && joins[uid]) staleJoin[uid] = joins[uid];      // a returning visitor goes to the back of the line
      if (uid && ownerUid === me()) try { scene.OneShot({ wp: WP.key, owner: me() }); } catch (err) {}
      recompute();
    });

    scene.On("one-shot", (e) => {
      let m; try { m = JSON.parse(e.detail.data); } catch (err) { return; }
      if (!m || m.wp !== WP.key) return;
      if (m.owner) { if (e.detail.fromAdmin) { ownerUid = m.owner; recompute(); } return; }   // only the real owner's word counts
      if (m.sync) { if (m.uid === host) onSync(m); return; }   // only follow the host
      quietUntil = Date.now() + 2500;
      doPlayback(m.cmd, m.s);
    });

    // ---------- Keeping everyone at the same moment ----------
    function onPage(m) {
      const now = Date.now();
      if (m.q && m.q !== lastQ) { lastQ = m.q; console.log("[Watch party] playing at " + m.q + " on a " + m.w + "x" + m.h + " page"); }
      page = { url: m.url, title: m.title, t: (typeof m.t === "number" ? m.t : null), d: m.live ? Infinity : (typeof m.d === "number" ? m.d : null),
               paused: m.paused, ad: !!m.ad, at: now };
      // The embed player refused this video (some can't be embedded): use the normal YouTube page on this screen
      const id = ytId(currentUrl);
      if (m.err && id && isEmbed(currentUrl) && !noEmbed.has(id)) {
        noEmbed.add(id);
        console.log("[Watch party] " + id + " won't play embedded; using the YouTube page");
        showUrl(watchUrl(id), true);
        return;
      }
      const users = Object.keys(scene.users || {}).length;
      if (isHost() && (myStampWritten || users <= 1)) {
        if (now - lastSent >= 2000) {
          lastSent = now;
          scene.OneShot({ wp: WP.key, sync: 1, uid: me(), url: currentUrl, t: page.t, paused: page.paused, ad: page.ad });
        }
        // the video finished: the next one in the queue starts by itself
        if (m.ended && lastEndedUrl !== currentUrl && !isIdle(currentUrl)) {
          lastEndedUrl = currentUrl;
          if (queue.length) playNext(); else { showUrl(IDLE); share({ [K.url]: encodeURIComponent(IDLE) }); }
        }
      } else follow();
    }
    function follow() {
      if (isHost() || !master || !page || master.t === null || page.t === null) return;
      if (master.ad || page.ad) return;
      if (!sameUrl(master.url, currentUrl) || !sameUrl(page.url, currentUrl)) return;
      const now = Date.now();
      if (now < quietUntil || now < settleUntil) return;
      const expected = master.t + (master.paused ? 0 : (now - master.at) / 1000);
      if (master.paused !== page.paused && page.paused !== null) {
        runInPage("window.__bsSeek&&window.__bsSeek(" + expected.toFixed(2) + ");window.__bsPlay&&window.__bsPlay(" + (!master.paused) + ")");
        quietUntil = now + 2500;
        return;
      }
      const mine = page.t + (page.paused ? 0 : (now - page.at) / 1000);
      if (Math.abs(expected - mine) > WP.drift) {
        runInPage("window.__bsSeek&&window.__bsSeek(" + (expected + (master.paused ? 0 : 0.6)).toFixed(2) + ")");
        quietUntil = now + 3000;
      }
    }
    function onSync(m) {
      master = { url: m.url, t: (typeof m.t === "number" ? m.t : null), paused: m.paused, ad: !!m.ad, at: Date.now() };
      // (just after I picked something, the host's next report may still name the old video: wait for it)
      if (m.url && !sameUrl(m.url, currentUrl) && Date.now() > settleUntil) showUrl(m.url);
      follow();
    }
    // Where my screen is now, counting the time since its last report
    const nowT = () => page && typeof page.t === "number" ? page.t + (page.paused ? 0 : (Date.now() - page.at) / 1000) : null;

    // ---------- Building it ----------
    scene.On("unity-loaded", async () => {
      // Everything hangs off one object at the snippet's position and rotation
      const spot = new BS.GameObject({ name: "WatchParty", localPosition: new BS.Vector3(POS[0], POS[1], POS[2]),
                                       localEulerAngles: new BS.Vector3(ROT[0], ROT[1], ROT[2]) });
      const at = (x, y, z) => ({ parent: spot, localPosition: new BS.Vector3(x, y, z) });
      searchParent = at(0, -40, 0);                 // the hidden search page, well out of sight

      // The screen
      const screen = new BS.GameObject({ name: "WatchPartyScreen", localScale: new BS.Vector3(WP.scale, WP.scale, 1), ...at(0, 0, 0) });
      if (!currentUrl) currentUrl = IDLE;
      browser = await screen.AddComponent(new BS.Browser({ url: pendingUrl || pageFor(currentUrl), pageWidth: WP.pageW, pageHeight: WP.pageH }));
      if (PLAYER_BASE && !playerOpenedAt) playerOpenedAt = Date.now();
      setPageSize(currentUrl);
      const inject = () => browser.RunActions(JSON.stringify({ actions: [{ actionType: "runscript", strParam1: PAGE_WATCH }] }));
      setTimeout(inject, 2000); setInterval(inject, 2000);

      screen.On("browser-message", (e) => {
        let m; try { m = JSON.parse(e.detail); } catch (err) { return; }
        if (!m || m.from !== "wp") return;
        if (m.player) playerOk = true;
        if (m.url && /^https?:/i.test(m.url) && !isIdle(currentUrl) && !sameUrl(m.url, currentUrl) && Date.now() > settleUntil) {
          showUrl(currentUrl, true);                                 // the screen only ever shows the chosen video
          return;
        }
        onPage(m);
      });

      // Volume: my own slider x how far I am from the screen
      let lastDist = null;
      let distanceFactor = 1, myVolume = WP.startVolume, muted = false, sentVol = -1, lastVol = 0, screenPos = null;
      // Where the screen is in the world (asked for directly: a screen that never moves may never report it)
      screenPos = { x: POS[0], y: POS[1], z: POS[2] };   // the screen's middle is the snippet's position
      const readScreenPos = async () => {
        if (screenPos) return true;
        try {
          await spot.transform.GetProperties([BS.PN.position]);
          const p = spot.transform.position;
          if (p && isFinite(p.x)) { screenPos = { x: p.x, y: p.y, z: p.z }; return true; }
        } catch (err) {}
        return false;
      };
      if (spot) try { spot.WatchTransform([BS.PN.position], (t) => { if (t && t.position) screenPos = { x: t.position.x, y: t.position.y, z: t.position.z }; }); } catch (err) {}
      (async () => { for (let i = 0; i < 30 && !(await readScreenPos()); i++) await new Promise((r) => setTimeout(r, 1000));
        console.log("[Watch party] screen is at " + (screenPos ? [screenPos.x, screenPos.y, screenPos.z].map((n) => n.toFixed(1)).join(", ") : "(unknown: distance volume off)")); })();
      scene.On("pose-update", (e) => {
        const hd = e.detail && e.detail.head;
        const h = hd && (hd.position || (hd.x !== undefined ? hd : null));
        if (!h || !screenPos) return;
        const d = Math.sqrt((h.x - screenPos.x) ** 2 + (h.y - screenPos.y) ** 2 + (h.z - screenPos.z) ** 2);
        const v = Math.max(0, Math.min(1, 1 - (d - WP.fullVolumeWithin) / (WP.silentBeyond - WP.fullVolumeWithin)));
        distanceFactor = WP.distanceVolume ? Math.pow(v, WP.fadeCurve) : 1;
        lastDist = d;
      });
      setInterval(() => {
        const want = muted ? 0 : Math.round(myVolume * distanceFactor * 100) / 100;
        if (Math.abs(want - sentVol) < 0.01 && Date.now() - lastVol < 2000) return;   // only when it changes (plus a reminder every 2 s)
        sentVol = want; lastVol = Date.now();
        runInPage("window.__bsVol&&window.__bsVol(" + want + ")");
        try { browser.RunActions(JSON.stringify({ actions: [{ actionType: "postmessage", strParam1: JSON.stringify({ wpvol: want }) }] })); } catch (err) {}
      }, 200);

      // Host label above the screen
      const screenW = (WP.pageW / 1300) * WP.scale, screenH = (WP.pageH / 1300) * WP.scale;
      const labelObj = new BS.GameObject({ name: "WatchPartyHost", ...at(0, screenH / 2 + WP.hostLabelAbove, 0) });
      const label = await labelObj.AddComponent(new BS.Text({
        text: "", fontSize: 0.6, color: new BS.Vector4(1, 1, 1, 0.9),
        horizontalAlignment: BS.HorizontalAlignment.Center, verticalAlignment: BS.VerticalAlignment.Center,
        enableWordWrapping: false, rectTransformSizeDelta: new BS.Vector2(4, 0.5),
      }));
      try { await labelObj.AddComponent(new BS.Billboard()); } catch (err) {}
      refreshLabel = () => {
        try { label.text = hostHere() ? "Host: " + nameOf(host) + (locked ? "  (locked)" : "") : ""; } catch (err) {}
      };

      // ---------- UI helpers ----------
      const box = (ui, parent, styles) => { const e = ui.CreateVisualElement(parent); if (styles) e.SetStyles(styles); return e; };
      const text = (ui, parent, t, styles) => {
        const e = ui.CreateLabel(t, parent);
        e.SetStyles(Object.assign({ color: C.text, fontSize: 20, whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }, styles || {}));
        return e;
      };
      const btn = (ui, parent, t, styles, onClick) => {
        const b = ui.CreateButtonWithText(t, "", parent);
        b.SetStyles(Object.assign({ height: 56, minWidth: 56, marginLeft: 4, marginRight: 4, paddingLeft: 12, paddingRight: 12,
          fontSize: 22, color: C.text, backgroundColor: C.button, borderRadius: 12, borderWidth: 0 }, styles || {}));
        if (onClick) b.OnClick(onClick);
        return b;
      };
      const outlined = { backgroundColor: "rgba(0,0,0,0)", borderWidth: 2, borderColor: C.outline };
      const chip = (ui, parent, t, bg, fg) => text(ui, parent, t, { fontSize: 15, fontWeight: "bold", color: fg || C.text, backgroundColor: bg || C.chip,
        borderRadius: 8, paddingLeft: 8, paddingRight: 8, paddingTop: 3, paddingBottom: 3, marginLeft: 8 });
      // Drawn icons: bars plus triangle characters, like the snippet's
      const bar = (ui, parent, w, h) => box(ui, parent, { width: w, height: h, backgroundColor: C.text, marginLeft: 2, marginRight: 2 });
      const glyph = (ui, parent, ch, size) => text(ui, parent, ch, { fontSize: size || 22, overflow: "visible", textOverflow: "clip" });
      const iconBtn = (ui, parent, draw, styles, onClick) => {
        const b = btn(ui, parent, "", Object.assign({ flexDirection: "row", alignItems: "center", justifyContent: "center", width: 64 }, styles || {}), onClick);
        draw(b); return b;
      };

      // ================= The control bar under the screen =================
      const BAR_W = 600, BAR_H = 140, bs = WP.barWidth / (BAR_W / 100);
      const barObj = new BS.GameObject({ name: "WatchPartyBar", localScale: new BS.Vector3(bs, bs, bs),
        ...at(0, -(screenH / 2 + (BAR_H / 100) * bs / 2 + 0.05), 0) });
      const bui = new BS.UI(new BS.Vector2(BAR_W, BAR_H));
      await barObj.AddComponent(bui);
      bui.SetBackgroundColor(new BS.Vector4(0, 0, 0, 0));
      const broot = box(bui, null, { width: "100%", height: "100%", backgroundColor: C.bg, borderRadius: 20,
        paddingLeft: 14, paddingRight: 14, paddingTop: 8, paddingBottom: 8, flexDirection: "column", justifyContent: "space-between" });
      const top = box(bui, broot, { flexDirection: "row", alignItems: "center", height: 52 });
      const topText = box(bui, top, { flexDirection: "column", flexGrow: 1, flexShrink: 1, overflow: "hidden" });
      const nowTitle = text(bui, topText, "Nothing playing", { fontSize: 22, fontWeight: "bold" });
      const nowStatus = text(bui, topText, "", { fontSize: 14, color: C.dim });
      let collapsed = false;
      const collapseBtn = btn(bui, top, "▼", { width: 40, height: 40, minWidth: 40, fontSize: 18, paddingLeft: 0, paddingRight: 0 }, () => setCollapsed(true));
      const bottom = box(bui, broot, { flexDirection: "row", alignItems: "center", height: 60 });
      iconBtn(bui, bottom, (b) => { bar(bui, b, 4, 22); glyph(bui, b, "◀"); }, null, playPrev);
      const ppBtn = iconBtn(bui, bottom, () => {}, { backgroundColor: C.accent, width: 72 }, togglePlay);
      const ppPlay = glyph(bui, ppBtn, "▶", 24);
      const ppPause = box(bui, ppBtn, { flexDirection: "row" }); bar(bui, ppPause, 7, 24); bar(bui, ppPause, 7, 24);
      iconBtn(bui, bottom, (b) => { glyph(bui, b, "▶"); bar(bui, b, 4, 22); }, null, playNext);
      const muteBtn = iconBtn(bui, bottom, () => {}, null, () => { muted = !muted; refreshUi(); });
      bar(bui, muteBtn, 5, 10); glyph(bui, muteBtn, "◀", 20);
      const muteMark = glyph(bui, muteBtn, ")", 20);
      const vol = bui.CreateSlider(0, 100, bottom);
      vol.SetStyles({ width: 130, marginLeft: 6, marginRight: 6, flexShrink: 1 });
      vol.SetValue(Math.round(myVolume * 100));
      vol.OnChange((e) => { myVolume = Math.max(0, Math.min(1, Number(e.value) / 100)); muted = false; refreshUi(); });
      box(bui, bottom, { flexGrow: 1 });
      const plBtn = btn(bui, bottom, "Playlist", Object.assign({ minWidth: 120 }, outlined), () => togglePanel());
      // Collapsed: just a small ▲ in the corner
      const expandBtn = btn(bui, null, "▲", { position: "absolute", right: 0, bottom: 0, width: 56, height: 56, minWidth: 56,
        paddingLeft: 0, paddingRight: 0, backgroundColor: C.bg, borderRadius: 14 }, () => setCollapsed(false));
      expandBtn.visible = false;
      function setCollapsed(on) { collapsed = on; broot.visible = !on; expandBtn.visible = on; }
      void collapseBtn;

      // ================= The Playlist panel beside the screen =================
      const PW = 1280, PH = 800, ps = WP.panelWidth / (PW / 100);
      let panelObj = null, pui = null, panelOpen = false, tab = "queue";
      let header = null, body = null, statusChip = null, tabBtns = {}, seek = null, tNow = null, tEnd = null, livePill = null, fPlay = null;
      let bodyKids = [], typed = "", searchRow = null, typeTimer = null, seekDragAt = 0, seekTimer = null;

      async function buildPanel() {
        panelObj = new BS.GameObject({ name: "WatchPartyPlaylist", localScale: new BS.Vector3(ps, ps, ps),
          ...panelAt(true) });
        pui = new BS.UI(new BS.Vector2(PW, PH));
        await panelObj.AddComponent(pui);
        pui.SetBackgroundColor(new BS.Vector4(0, 0, 0, 0));
        const root = box(pui, null, { width: "100%", height: "100%", flexDirection: "column", backgroundColor: C.bgSolid, borderRadius: 24, overflow: "hidden" });

        // Header
        header = box(pui, root, { height: 104, flexDirection: "row", alignItems: "center", backgroundColor: C.panel, paddingLeft: 24, paddingRight: 16 });
        const titles = box(pui, header, { flexDirection: "column", marginRight: 16 });
        text(pui, titles, "VIDEO PLAYER", { fontSize: 16, fontWeight: "bold", color: C.dim });
        const tRow = box(pui, titles, { flexDirection: "row", alignItems: "center" });
        text(pui, tRow, "Playlist", { fontSize: 44, fontWeight: "bold", overflow: "visible" });
        box(pui, tRow, { width: 12, height: 12, borderRadius: 6, backgroundColor: C.accent, marginLeft: 8 });
        statusChip = text(pui, header, "", { fontSize: 15, fontWeight: "bold", borderWidth: 2, borderColor: C.outline, borderRadius: 10,
          paddingLeft: 10, paddingRight: 10, paddingTop: 4, paddingBottom: 4, marginRight: 16, maxWidth: 260 });
        for (const [id, name] of [["queue", "Queue"], ["search", "Search"], ["people", "People"]])
          tabBtns[id] = btn(pui, header, name, { minHeight: 48, height: 48, fontSize: 22 }, () => { tab = id; refreshUi(); });
        box(pui, header, { flexGrow: 1 });
        btn(pui, header, "✕", Object.assign({ width: 56, minWidth: 56, paddingLeft: 0, paddingRight: 0 }, outlined), () => togglePanel(false));

        // Body
        body = box(pui, root, { flexGrow: 1, flexDirection: "column", padding: 24, overflow: "hidden" });
        // The search box stays put (so typing isn't interrupted); only shown on the Search tab
        searchRow = box(pui, body, { flexDirection: "row", alignItems: "center", marginBottom: 12 });
        const field = new BS.UITextField(pui, searchRow);
        field.placeholder = "Search YouTube, or paste a YouTube / Twitch / video link";
        field.SetStyles({ flexGrow: 1, height: 52, fontSize: 20, borderRadius: 26, backgroundColor: C.chip, color: C.text, paddingLeft: 18 });
        field.OnChange((e) => {
          typed = e.value || "";
          clearTimeout(typeTimer);
          typeTimer = setTimeout(() => { if (typed.trim().length > 1 && typed.trim() !== searchQuery) runSearch(typed); }, 900);
        });
        btn(pui, searchRow, "Search", { backgroundColor: C.accent, height: 52 }, () => runSearch(typed));

        // Footer: transport + seek
        const footer = box(pui, root, { height: 104, backgroundColor: C.panel, flexDirection: "column", justifyContent: "center", paddingLeft: 24, paddingRight: 24 });
        const tr = box(pui, footer, { flexDirection: "row", alignItems: "center", justifyContent: "center" });
        const tb = (t, f, extra) => btn(pui, tr, t, Object.assign({ height: 44, fontSize: 20 }, extra || {}), f);
        tb("-30s", () => playback("skip", -30)); tb("-10s", () => playback("skip", -10));
        tb("|◀", playPrev);
        fPlay = tb("Play", togglePlay, { backgroundColor: C.accent, minWidth: 96 });
        tb("▶|", playNext);
        tb("+10s", () => playback("skip", 10)); tb("+30s", () => playback("skip", 30));
        const sr = box(pui, footer, { flexDirection: "row", alignItems: "center", marginTop: 6 });
        tNow = text(pui, sr, "0:00", { fontSize: 18, color: C.dim, width: 80 });
        seek = pui.CreateSlider(0, 100, sr);
        seek.SetStyles({ flexGrow: 1 });
        seek.OnChange((e) => {
          seekDragAt = Date.now();
          clearTimeout(seekTimer);
          seekTimer = setTimeout(() => playback("seekto", Number(e.value)), 350);
        });
        livePill = chip(pui, sr, "LIVE", C.live);
        livePill.visible = false;
        tEnd = text(pui, sr, "--:--", { fontSize: 18, color: C.dim, width: 80, textAlign: "right" });
      }
      // Closed = moved far out of sight (switching it off would wipe its contents)
      function panelAt(open) { return at(screenW / 2 + WP.panelGap + WP.panelWidth / 2, WP.panelY - (open ? 0 : 300), 0); }
      async function togglePanel(want) {
        panelOpen = typeof want === "boolean" ? want : !panelOpen;
        if (panelOpen && !panelObj) await buildPanel();
        else if (panelObj) await panelObj.SetLocalPosition(panelAt(panelOpen).localPosition);
        lastBodyKey = "";
        refreshUi();
      }

      // ---------- Body contents (rebuilt when something changes) ----------
      function clearBody() { for (const k of bodyKids) { try { k.Destroy(); } catch (err) {} } bodyKids = []; }
      const top_ = (e) => { bodyKids.push(e); return e; };
      function empty(t) { top_(text(pui, body, t, { fontSize: 22, color: C.muted, whiteSpace: "normal", marginTop: 20 })); }
      function itemRow(parent, n, item, active, buttons) {
        const r = box(pui, parent, { flexDirection: "row", alignItems: "center", height: 88, marginBottom: 8, paddingLeft: 10, paddingRight: 10,
          backgroundColor: active ? C.activeRow : C.row, borderRadius: 12, borderWidth: active ? 2 : 0, borderColor: C.accent });
        const th = thumbOf(item.url);
        const tbx = box(pui, r, { width: 128, height: 72, borderRadius: 10, backgroundColor: "#000", marginRight: 12, flexShrink: 0 });
        if (th) tbx.SetStyles({ backgroundImage: 'url("' + th + '")' });
        if (n) text(pui, r, n + ".", { fontSize: 20, color: C.dim, width: 44, flexShrink: 0 });
        const mid = box(pui, r, { flexDirection: "column", flexGrow: 1, flexShrink: 1, overflow: "hidden" });
        text(pui, mid, cut(item.title || "(untitled)", 48), { fontSize: 20, fontWeight: "bold" });
        const meta = box(pui, mid, { flexDirection: "row", alignItems: "center", marginTop: 6 });
        const badge = badgeOf(item.url, item.live);
        chip(pui, meta, badge, badge === "LIVE" ? C.live : "#e8e8ec", badge === "LIVE" ? C.text : "#141418").SetStyles({ marginLeft: 0 });
        if (item.d) text(pui, meta, item.d, { fontSize: 16, color: C.dim, marginLeft: 10 });
        if (active) chip(pui, meta, "Now playing", C.accent);
        for (const [t, f, accent] of buttons) btn(pui, r, t, { height: 48, fontSize: 20, backgroundColor: accent ? C.accent : C.button }, f);
        return r;
      }
      function pager(which, total, per) {
        const pagesN = Math.max(1, Math.ceil(total / per));
        pages[which] = Math.min(pages[which], pagesN - 1);
        const r = top_(box(pui, body, { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", marginTop: 4 }));
        btn(pui, r, "◀", { height: 44, fontSize: 20 }, () => { pages[which] = Math.max(0, pages[which] - 1); refreshUi(); });
        btn(pui, r, "▶", { height: 44, fontSize: 20 }, () => { pages[which] = Math.min(pagesN - 1, pages[which] + 1); refreshUi(); });
        text(pui, r, "Page " + (pages[which] + 1) + " of " + pagesN + " · " + total, { fontSize: 18, color: C.dim, marginLeft: 8 });
      }
      function renderQueue() {
        const list = top_(box(pui, body, { flexDirection: "column", flexGrow: 1 }));
        if (currentUrl && isVideoPage(currentUrl))
          itemRow(list, 0, { url: currentUrl, title: cleanTitle(page && page.title), d: page && page.d && isFinite(page.d) ? fmt(page.d) : "" }, true,
            []);
        if (!queue.length) { empty("Queue is empty… find something in Search and press Add."); return; }
        const start = pages.queue * 4;
        queue.slice(start, start + 4).forEach((it, k) => {
          const i = start + k;
          itemRow(list, i + 1, it, false, canControl()
            ? [["▶", () => queuePlay(i), true], ["▲", () => queueMove(i, -1)], ["▼", () => queueMove(i, 1)], ["✕", () => queueRemove(i)]]
            : []);
        });
        pager("queue", queue.length, 4);
      }
      function renderSearch() {
        const status = searchState === "searching" ? (readKind === "list" ? "Reading the playlist…" : "Searching…")
                     : searchState === "none" ? (readKind === "list" ? "Couldn't read that playlist (it may be private)" : "No results") : "";
        if (Date.now() < sayUntil || status) top_(text(pui, body, Date.now() < sayUntil ? sayText : status, { fontSize: 18, color: C.dim, marginBottom: 6 }));
        if (!results.length) { if (!status) empty("Type what you're looking for, then press Search."); return; }
        if (playlist && readKind === "list") {          // the playlist banner: play or add the lot
          const bn = top_(box(pui, body, { flexDirection: "row", alignItems: "center", backgroundColor: C.activeRow, borderRadius: 12,
            borderWidth: 2, borderColor: C.accent, paddingLeft: 14, paddingRight: 8, height: 64, marginBottom: 8 }));
          text(pui, bn, cut(playlist.title, 40) + "  ·  " + playlist.count + " videos", { fontSize: 20, fontWeight: "bold", flexGrow: 1, flexShrink: 1 });
          btn(pui, bn, "Add all", { height: 48, fontSize: 20 }, () => importPlaylist(results, false));
          btn(pui, bn, "Play all", { height: 48, fontSize: 20, backgroundColor: C.accent }, () => importPlaylist(results, true));
        }
        const list = top_(box(pui, body, { flexDirection: "column", flexGrow: 1 }));
        const per = playlist && readKind === "list" ? 3 : 4;
        const start = pages.search * per;
        results.slice(start, start + per).forEach((it) => {
          const playing = currentUrl && sameUrl(it.url, currentUrl);
          itemRow(list, 0, it, playing, [["Add", () => enqueue(it)], ["Play", () => play(it.url), true]]);
        });
        pager("search", results.length, per);
      }
      function renderPeople() {
        const r1 = top_(box(pui, body, { flexDirection: "row", alignItems: "center", marginBottom: 14 }));
        if (isHost()) btn(pui, r1, locked ? "Locked (host only)" : "Unlocked (everyone can control)", { height: 52 }, () => setLock(!locked));
        else text(pui, r1, locked ? "Locked: only the host can control" : "Unlocked: everyone can control", { fontSize: 22, color: C.dim });
        if (!isHost() && !locked) btn(pui, r1, "Take host", { backgroundColor: C.accent, height: 52, marginLeft: 12 }, () => makeHost(me()));
        const list = top_(box(pui, body, { flexDirection: "column", flexGrow: 1 }));
        const users = Object.values(scene.users || {}).sort((a, b) => String(a.name).localeCompare(String(b.name)));
        if (!users.length) users.push({ uid: me(), name: "You" });
        for (const u of users.slice(0, 7)) {
          const r = box(pui, list, { flexDirection: "row", alignItems: "center", height: 64, marginBottom: 6, paddingLeft: 16, paddingRight: 10,
            backgroundColor: C.row, borderRadius: 12 });
          text(pui, r, cut(u.name || "someone", 40) + (u.uid === me() ? "  (you)" : ""), { fontSize: 22, flexGrow: 1 });
          if (u.uid === host) chip(pui, r, "HOST", C.accent);
          else if (isHost() || !locked) btn(pui, r, "Make host", { height: 48, fontSize: 20 }, () => makeHost(u.uid));
          if (u.uid === ownerUid) chip(pui, r, "OWNER", C.chip);
        }
        top_(text(pui, body, "your id: " + me(), { fontSize: 14, color: C.muted }));
      }
      let lastBodyKey = "";
      function renderBody(force) {
        if (!pui || !panelOpen) return;
        const key = [tab, queue.map((q) => q.url).join(","), pages.queue, pages.search, results.length, results.map((r) => r.title).join("|"),
          searchState, host, locked, Object.keys(scene.users || {}).join(","), currentUrl, page && page.title, Date.now() < sayUntil ? sayText : ""].join("§");
        if (!force && key === lastBodyKey) return;
        lastBodyKey = key;
        clearBody();
        try { searchRow.visible = tab === "search"; } catch (err) {}
        if (tab === "queue") renderQueue(); else if (tab === "search") renderSearch(); else renderPeople();
      }

      // ---------- Keeping the controls up to date ----------
      function status() {
        if (Date.now() < sayUntil) return sayText;
        const s = [];
        if (isHost()) s.push("You host"); else if (hostHere()) s.push("Host: " + nameOf(host)); else s.push("No host");
        if (locked) s.push("Locked");
        if (page && page.d === Infinity) s.push("LIVE");
        if (WP.showDistance) s.push((lastDist === null ? (screenPos ? "no head position yet" : "screen position unknown") : lastDist.toFixed(1) + " m") +
          " · vol " + (muted ? 0 : Math.round(myVolume * distanceFactor * 100)) + "%");
        else if (distanceFactor < 0.98 && !muted) s.push("Vol " + Math.round(myVolume * distanceFactor * 100) + "%");
        if (queue.length) s.push(queue.length + " in queue");
        return s.join(" · ");
      }
      refreshUi = () => {
        const playing = page && page.paused === false;
        try { nowTitle.text = isIdle(currentUrl) ? "Nothing playing" : cut(cleanTitle(page && page.title) || "Loading…", 40); } catch (err) {}
        try { nowStatus.text = status(); } catch (err) {}
        try { ppPlay.visible = !playing; ppPause.visible = !!playing; } catch (err) {}
        try { muteMark.text = muted ? "✕" : ")"; } catch (err) {}
        try { plBtn.text = panelOpen ? "Close" : "Playlist"; } catch (err) {}
        try { if (browser) browser.ToggleInteraction(false); } catch (err) {}   // the screen can't be clicked or browsed
        if (pui && panelOpen) {
          try { statusChip.text = (isHost() ? "YOU HOST" : hostHere() ? "HOST: " + cut(nameOf(host), 16).toUpperCase() : "NO HOST") + (locked ? " · LOCKED" : ""); } catch (err) {}
          for (const id in tabBtns) try { tabBtns[id].SetStyles({ backgroundColor: id === tab ? C.accent : C.button }); } catch (err) {}
          try { fPlay.text = playing ? "Pause" : "Play"; } catch (err) {}
          renderBody();
        }
      };
      // Times and the seek bar, twice a second
      setInterval(() => {
        try { nowStatus.text = status(); } catch (err) {}
        if (!pui || !panelOpen) return;
        const t = nowT(), d = page && page.d;
        const live = d === Infinity;
        try { livePill.visible = live; } catch (err) {}
        try { tNow.text = fmt(t); tEnd.text = live ? "" : fmt(d); } catch (err) {}
        if (!live && typeof d === "number" && isFinite(d) && d > 0 && t !== null && Date.now() - seekDragAt > 1500) {
          try { seek.SetRange(0, Math.floor(d)); seek.SetValue(Math.min(d, t)); } catch (err) {}
        }
        renderBody();
      }, 500);
      refreshUi(); refreshLabel();
    });
  });
})();
