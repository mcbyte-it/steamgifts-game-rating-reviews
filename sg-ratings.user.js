// ==UserScript==
// @name         SteamGifts – Steam Game Info (rating, release date, genres)
// @namespace    mcbyte
// @version      1.5.2
// @description  Replaces the Steam store icon with a clickable rating badge + tooltip (all-review label, release date, genres, per-game refresh) on SteamGifts listings
// @author       mcbyte
// @include      https://www.steamgifts.com/*
// @exclude      https://www.steamgifts.com/discussion/*
// @exclude      https://www.steamgifts.com/discussions*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @connect      store.steampowered.com
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/mcbyte-it/steamgifts-game-rating-reviews/main/sg-ratings.user.js
// @downloadURL  https://raw.githubusercontent.com/mcbyte-it/steamgifts-game-rating-reviews/main/sg-ratings.user.js
// ==/UserScript==

(function () {
    'use strict';

    /* ================= config ================= */
    const CACHE_PREFIX   = 'sgr3_';
    const CACHE_TTL      = 30 * 24 * 60 * 60 * 1000; // 30 days
    const CACHE_TTL_FAIL = 2  * 60 * 60 * 1000;      // 2 hours (avoid hammering permanently-failing apps)
    const CACHE_TTL_FRESH = 24 * 60 * 60 * 1000;     // 1 day (games with few reviews, volatile scores)
    const FRESH_THRESHOLD = 50;                      // < this many reviews => volatile, short TTL
    const CONCURRENCY  = 4;
    const REQ_DELAY    = 200;
    const CC           = 'us';
    const LANG         = 'english';

    /* ================= styles ================= */
    GM_addStyle(`
        a.sgr-badge{
            display:inline-flex;align-items:center;gap:4px;
            margin-left:6px;padding:1px 6px;border-radius:3px;
            font-size:11px;font-weight:700;line-height:16px;vertical-align:middle;
            color:#fff !important;cursor:pointer;white-space:nowrap;
            position:relative;text-decoration:none;
            z-index:1;
        }
        a.sgr-badge:hover{color:#fff !important;filter:brightness(1.12);z-index:1000;}
        a.sgr-badge .fa-steam{font-size:12px}
        .sgr-loading{background:#9aa0a6;opacity:.6}
        .sgr-err    {background:#7f8c8d}
        .sgr-none   {background:#95a5a6}
        .sgr-vneg   {background:#a12d2f}
        .sgr-neg    {background:#c0392b}
        .sgr-mixed  {background:#b0761a}
        .sgr-pos    {background:#4c8ab0}
        .sgr-vpos   {background:#2f7fa8}
        .sgr-ovpos  {background:#1f8a4c}

        /* wrapper carries a transparent top bridge so the mouse can cross into the box */
        .sgr-tip{
            display:none;position:absolute;z-index:10000;left:0;top:100%;
            padding-top:6px;
        }
        a.sgr-badge:hover .sgr-tip,
        .sgr-tip:hover{display:block}
        .sgr-tip-inner{
            width:290px;padding:10px 12px;border-radius:5px;
            background:#1b2838;color:#c7d5e0;border:1px solid #000;
            box-shadow:0 4px 14px rgba(0,0,0,.45);
            font-size:12px;font-weight:400;line-height:1.5;text-align:left;
            white-space:normal;cursor:default;
        }
        .sgr-tip .sgr-t-title{font-weight:700;color:#fff;margin-bottom:6px;font-size:13px}
        .sgr-tip .sgr-t-row{margin:3px 0}
        .sgr-tip .sgr-t-lbl{color:#8f98a0;display:inline-block;min-width:82px}
        .sgr-tip .sgr-t-tags{margin-top:8px;padding-top:7px;border-top:1px solid #2a475e}
        .sgr-tip .sgr-t-tag{
            display:inline-block;margin:2px 3px 2px 0;padding:2px 6px;border-radius:2px;
            background:#2a475e;color:#c7d5e0;font-size:11px;
        }
        .sgr-tip .sgr-t-refresh{margin-top:8px;padding-top:7px;border-top:1px solid #2a475e;
            display:flex;justify-content:space-between;align-items:center;gap:8px}
        .sgr-tip .sgr-t-stale{color:#66707a;font-size:10px;font-style:italic}
        .sgr-tip .sgr-t-refresh a{color:#66c0f4;text-decoration:none;font-size:11px;cursor:pointer;white-space:nowrap}
        .sgr-tip .sgr-t-refresh a:hover{text-decoration:underline}
    `);

    /* ================= cache ================= */
    const FAILED = Symbol('sgr-failed'); // sentinel: cached "lookup failed" marker

    function cacheGet(appid) {
        const raw = GM_getValue(CACHE_PREFIX + appid, null);
        if (!raw) return null;
        try {
            const o = JSON.parse(raw);
            let ttl;
            if (o.f) {
                ttl = CACHE_TTL_FAIL;
            } else {
                // volatile TTL for low-review games so new releases self-correct
                const total = o.d && o.d.reviews ? o.d.reviews.total : null;
                ttl = (total !== null && total < FRESH_THRESHOLD) ? CACHE_TTL_FRESH : CACHE_TTL;
            }
            if (Date.now() - o.t > ttl) return null;
            return o.f ? FAILED : o.d;
        } catch (e) { return null; }
    }
    function cacheSet(appid, d) {
        GM_setValue(CACHE_PREFIX + appid, JSON.stringify({ t: Date.now(), d }));
    }
    function cacheSetFail(appid) {
        GM_setValue(CACHE_PREFIX + appid, JSON.stringify({ t: Date.now(), f: 1 }));
    }
    GM_registerMenuCommand('Clear Steam info cache', () => {
        let n = 0;
        GM_listValues().forEach(k => {
            if (k.indexOf(CACHE_PREFIX) === 0) { GM_deleteValue(k); n++; }
        });
        alert(`Cleared ${n} cached game(s). Reload the page.`);
    });

    /* ================= helpers ================= */
    const fmt = n => Number(n).toLocaleString();
    const ESCAPE_MAP = { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' };
    const esc = s => String(s).replace(/[&<>"']/g, c => ESCAPE_MAP[c]);

    function gmGet(url) {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET', url, timeout: 15000,
                headers: { 'Accept-Language': 'en-US,en;q=0.9' },
                onload:  r => resolve(r.status >= 200 && r.status < 300 ? r.responseText : null),
                onerror: () => resolve(null),
                ontimeout: () => resolve(null)
            });
        });
    }

    function getOrCreateIcon(badge) {
        let icon = badge.querySelector(':scope > i.fa-steam');
        if (!icon) {
            icon = document.createElement('i');
            icon.className = 'fa fa-fw fa-steam';
        }
        return icon;
    }

    function loadingBadge(badge) {
        const icon = getOrCreateIcon(badge);
        badge.className = 'sgr-badge sgr-loading';
        badge.textContent = '';
        badge.appendChild(icon);
        badge.appendChild(document.createTextNode('…'));
        badge.title = '';
    }

    /* ================= data sources ================= */
    async function getReviews(appid) {
        const txt = await gmGet(`https://store.steampowered.com/appreviews/${appid}?json=1&language=all&purchase_type=all&num_per_page=0`);
        if (!txt) return null;
        try {
            const j = JSON.parse(txt);
            if (j.success !== 1 || !j.query_summary) return null;
            const q = j.query_summary;
            return {
                desc:  q.review_score_desc || 'No user reviews',
                pos:   q.total_positive || 0,
                total: q.total_reviews  || 0
            };
        } catch (e) { return null; }
    }

    async function getDetails(appid) {
        const txt = await gmGet(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=${CC}&l=${LANG}`);
        if (!txt) return null;
        try {
            const j = JSON.parse(txt);
            const entry = j[appid];
            if (!entry || !entry.success || !entry.data) return null;
            const d = entry.data;
            return {
                name:    d.name || null,
                release: (d.release_date && d.release_date.date) || null,
                coming:  !!(d.release_date && d.release_date.coming_soon),
                genres:  (d.genres || []).map(g => g.description).filter(Boolean)
            };
        } catch (e) { return null; }
    }

    async function fetchAll(appid) {
        const [reviews, details] = await Promise.all([getReviews(appid), getDetails(appid)]);
        if (!reviews && !details) return null;
        return { reviews, details };
    }

    /* ================= rendering ================= */
    function scoreClass(pct, total) {
        if (!total) return 'sgr-none';
        if (total >= 500 && pct >= 95) return 'sgr-ovpos';
        if (total >= 500 && pct >= 80) return 'sgr-vpos';
        if (pct >= 70) return 'sgr-pos';
        if (pct >= 40) return 'sgr-mixed';
        if (pct >= 20) return 'sgr-neg';
        return 'sgr-vneg';
    }

    function render(badge, appid, d) {
        const r = d.reviews;
        const s = d.details || {};

        // icon + label live inside the anchor; reuse the loading-state icon if present
        const icon = getOrCreateIcon(badge);

        badge.className = 'sgr-badge';
        badge.title = '';

        let pct = null, label, totalFmt = null;
        if (r && r.total) {
            pct = Math.round((r.pos / r.total) * 100);
            badge.classList.add(scoreClass(pct, r.total));
            totalFmt = fmt(r.total);
            label = pct + '% (' + totalFmt + ')';
        } else {
            badge.classList.add('sgr-none');
            label = 'N/A';
        }

        badge.textContent = '';
        badge.appendChild(icon);
        badge.appendChild(document.createTextNode(label));

        const rows = [];
        rows.push(`<div class="sgr-t-row"><span class="sgr-t-lbl">All Reviews:</span>${
            r ? esc(r.desc) + (r.total ? ` (${totalFmt})` : '') : 'unknown'}</div>`);
        if (pct !== null) {
            rows.push(`<div class="sgr-t-row"><span class="sgr-t-lbl">Positive:</span>${pct}% — ${fmt(r.pos)} of ${totalFmt}</div>`);
        }
        rows.push(`<div class="sgr-t-row"><span class="sgr-t-lbl">Release:</span>${
            s.release ? esc(s.release) + (s.coming ? ' (coming soon)' : '') : 'unknown'}</div>`);

        const tagsHtml = (s.genres && s.genres.length)
            ? '<div class="sgr-t-tags">' + s.genres.map(g => `<span class="sgr-t-tag">${esc(g)}</span>`).join('') + '</div>'
            : '';

        const volatile = r && r.total > 0 && r.total < FRESH_THRESHOLD;
        const staleNote = volatile ? '<span class="sgr-t-stale">few reviews — may shift</span>' : '<span></span>';

        // tooltip = wrapper (transparent bridge) > inner (visible box)
        const tip = document.createElement('div');
        tip.className = 'sgr-tip';
        tip.innerHTML =
            '<div class="sgr-tip-inner">' +
                `<div class="sgr-t-title">${esc(s.name || 'Steam App ' + appid)}</div>` +
                rows.join('') + tagsHtml +
                `<div class="sgr-t-refresh">${staleNote}<a data-sgr-refresh href="#">↻ Refresh</a></div>` +
            '</div>';

        // clicks inside the tooltip must not navigate to the store
        tip.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); });
        tip.querySelector('[data-sgr-refresh]').addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            refreshGame(appid);
        });
        badge.appendChild(tip);

        badge.addEventListener('mouseenter', () => {
            tip.style.left = '0px';
            const overflow = tip.querySelector('.sgr-tip-inner')
                .getBoundingClientRect().right - (window.innerWidth - 12);
            if (overflow > 0) tip.style.left = (-overflow) + 'px';
        });
    }

    function renderErr(badge) {
        const icon = getOrCreateIcon(badge);
        badge.className = 'sgr-badge sgr-err';
        badge.textContent = '';
        badge.appendChild(icon);
        badge.appendChild(document.createTextNode('?'));
        badge.title = 'Failed to load Steam info';
    }

    /* refresh a single game: drop its cache, re-fetch, update every badge for it */
    function refreshGame(appid) {
        GM_deleteValue(CACHE_PREFIX + appid);
        const targets = [...document.querySelectorAll('a.sgr-badge')]
            .filter(b => b.dataset.sgrAppid === appid);
        if (!targets.length) return;
        targets.forEach(loadingBadge);
        fetchAll(appid).then(d => {
            if (d) { cacheSet(appid, d); targets.forEach(b => render(b, appid, d)); }
            else   { cacheSetFail(appid); targets.forEach(renderErr); }
        });
    }

    /* ================= queue ================= */
    const queue   = [];
    const pending = new Map();
    let active = 0;

    function pump() {
        while (active < CONCURRENCY && queue.length) {
            const appid = queue.shift();
            active++;
            fetchAll(appid).then(d => {
                const badges = pending.get(appid) || [];
                pending.delete(appid);
                if (d) { cacheSet(appid, d); badges.forEach(b => render(b, appid, d)); }
                else   { cacheSetFail(appid); badges.forEach(renderErr); }
            }).finally(() => {
                active--;
                setTimeout(pump, REQ_DELAY);
            });
        }
    }

    function enqueue(appid, badge) {
        if (pending.has(appid)) { pending.get(appid).push(badge); return; }
        pending.set(appid, [badge]);
        queue.push(appid);
        pump();
    }

    /* ================= scan ================= */
    const APPID_RE = /store\.steampowered\.com\/app\/(\d+)/;

    function scan(root) {
        const scope = root instanceof Element ? root : document;
        scope.querySelectorAll('a[href*="store.steampowered.com/app/"]:not([data-sgr])').forEach(link => {
            // Only take over the small steam-icon link. Some pages (e.g. a single
            // giveaway's featured header) also link the game's cover image to the
            // same store URL — badging that one would hide the artwork.
            if (!link.querySelector('i.fa-steam')) return;
            const m = link.href.match(APPID_RE);
            if (!m) return;
            link.setAttribute('data-sgr', '1');
            const appid = m[1];
            const storeUrl = link.href;

            // badge is now a clickable anchor to the store
            const badge = document.createElement('a');
            badge.className = 'sgr-badge sgr-loading';
            badge.href = storeUrl;
            badge.target = '_blank';
            badge.rel = 'nofollow noopener';
            badge.dataset.sgrAppid = appid;
            const li = document.createElement('i');
            li.className = 'fa fa-fw fa-steam';
            badge.appendChild(li);
            badge.appendChild(document.createTextNode('…'));

            link.insertAdjacentElement('afterend', badge);
            link.style.display = 'none'; // hide original icon; badge replaces it

            const cached = cacheGet(appid);
            if (cached === FAILED) { renderErr(badge); return; }
            if (cached) { render(badge, appid, cached); return; }
            enqueue(appid, badge);
        });
    }

    scan(document);

    // Dedupe added nodes across a mutation batch before scanning: skip any node
    // already covered by an ancestor in the same batch, so overlapping/nested
    // mutations (e.g. a whole list re-rendered at once) don't get scanned twice.
    function scanBatch(nodes) {
        const roots = [];
        outer:
        for (const n of nodes) {
            for (let i = roots.length - 1; i >= 0; i--) {
                if (roots[i].contains(n)) continue outer;
                if (n.contains(roots[i])) roots.splice(i, 1);
            }
            roots.push(n);
        }
        roots.forEach(scan);
    }

    new MutationObserver(muts => {
        const nodes = [];
        for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) nodes.push(n);
        if (nodes.length) scanBatch(nodes);
    }).observe(document.body, { childList: true, subtree: true });
})();