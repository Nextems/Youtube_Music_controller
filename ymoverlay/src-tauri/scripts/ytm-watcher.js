// Injected into the hidden "main" window (music.youtube.com) once at app
// startup via WebviewWindow::eval() in main.rs.
//
// SELECTOR NOTE: these class/id names come from YouTube Music's current
// web player markup and are NOT a public API - Google can and does change
// them without notice. If state stops updating, open devtools on the
// hidden window (temporarily flip `visible: true` in tauri.conf.json to
// inspect it) and re-check these selectors first.
//
// PERFORMANCE NOTE: this is split into three separate events instead of
// one big blob, specifically so React doesn't rebuild the queue list /
// track-info UI twice a second when only the playhead moved:
//   - "ytm://tick"  - isPlaying/currentTime/duration/volume - every 1000ms,
//                     always (this is cheap, just a handful of numbers)
//   - "ytm://track" - title/artist/art - only emitted when it actually changes
//   - "ytm://queue" - up to 10 upcoming tracks - only emitted when it changes
// Diffing happens here (in the page), not in React, so unchanged data never
// even crosses the IPC boundary.
//
// TIMER NOTE: YTM does not reset <video>.currentTime to 0 between queued
// tracks - it runs one continuous, non-resetting clock across the whole
// gapless session, so the raw DOM value is "seconds into the session",
// not "seconds into this track". The fix is not fancier math (no
// performance.now(), no deltas, no local clock) - it's a per-track
// offset: the instant the title changes, the current raw reading is
// remembered as that track's start offset, and every following tick for
// the same track just subtracts it from a fresh raw reading. See
// trackStartOffset and tick() below.

(function () {
  if (window.__ymoverlayWatcherInstalled) return;
  window.__ymoverlayWatcherInstalled = true;

  // Shared helpers reused by later one-shot scripts (ytmBridge.js actions
  // like "like this track" or "add to playlist"), so those scripts stay
  // short and don't have to redefine this search logic every single call.
  window.__ymoverlay = {
    wait: function (ms) {
      return new Promise(function (resolve) {
        setTimeout(resolve, ms);
      });
    },
    // "Is this element actually rendered?" WITHOUT forcing layout.
    // offsetParent / getBoundingClientRect / getClientRects all make the
    // browser run a synchronous layout of the whole (huge) YTM page if
    // anything is dirty - and YTM dirties it constantly - which measured
    // at 15ms+ per call batch on a ~36k-node page. checkVisibility()
    // (Chromium 105+, Safari 17.4+, Firefox 106+) only needs a style
    // update and answers the same question (false for display:none
    // self/ancestors). Older webviews fall back to offsetParent.
    isVisible: function (el) {
      return typeof el.checkVisibility === "function"
        ? el.checkVisibility()
        : el.offsetParent !== null;
    },
    // SINGLE SOURCE OF TRUTH for "which queue items count, and in what
    // order". YTM renders hidden/duplicate <ytmusic-player-queue-item>
    // nodes (offscreen copies used for animation/measurement) alongside
    // the real, visible rows. Every consumer - the watcher's readQueue()
    // AND ytmBridge.js's selectQueueItem()/menu actions - MUST filter
    // through this exact function before indexing, or their indices will
    // silently drift apart (this is what caused the old "click row 3,
    // track 2 plays" off-by-one bug: readQueue() filtered, selectQueueItem()
    // didn't, so index N in the UI stopped matching raw DOM index N as
    // soon as a hidden node sorted in earlier than N).
    getQueueItems: function () {
      return Array.from(
        window.__ymoverlay.getQueueContainer().querySelectorAll("ytmusic-player-queue-item")
      ).filter(function (el) {
        return window.__ymoverlay.isVisible(el);
      });
    },
    // Caches the queue panel's own wrapping element so getQueueItems()
    // can scope its querySelectorAll to that subtree instead of the
    // whole document. Two reasons this matters, both purely about scan
    // COST (never about which items are found - the query itself,
    // "ytmusic-player-queue-item", is unchanged, so results are
    // identical either way):
    //  1. music.youtube.com is a large, long-lived SPA page with plenty
    //     of unrelated markup (sidebar, search, related content) that a
    //     document-wide querySelectorAll has to walk past on every call.
    //  2. The main window here is the user's actual, VISIBLE YTM tab
    //     (see tauri.conf.json) - they may have it open and be browsing
    //     around it while music plays, so "the whole document" is not a
    //     stable, queue-only universe the way it would be in a hidden
    //     worker page.
    // Cached and revalidated with isConnected (cheap) rather than
    // re-queried every call; falls back to `document` if no container
    // has ever been found yet (correct, just uncached, so behavior never
    // regresses - only the optimization is skipped).
    _queueContainer: null,
    getQueueContainer: function () {
      if (window.__ymoverlay._queueContainer && window.__ymoverlay._queueContainer.isConnected) {
        return window.__ymoverlay._queueContainer;
      }
      const found =
        document.querySelector("ytmusic-player-queue") ||
        document.querySelector("#queue-container") ||
        document;
      window.__ymoverlay._queueContainer = found === document ? null : found;
      return found;
    },
    // Same "hidden/duplicate node" problem getQueueItems() guards against
    // shows up one level down too: YTM's responsive layouts commonly
    // render two copies of a row's own title/byline/art nodes (e.g. one
    // desktop, one mobile) with only one actually visible via CSS, and a
    // plain querySelector() has no idea which copy is real - it just
    // returns document order, which is not necessarily the visible one.
    // A stale/empty hidden copy silently corrupts the field it's read
    // into (wrong or blank title/artist/art), which is exactly the kind
    // of desync bug getQueueItems() already prevents at the row level -
    // this is the same fix applied to look INSIDE a row (or the player
    // bar) rather than across rows. Scoped to `root` (a single row, or
    // `document` for the player bar) so it never reaches across into an
    // unrelated row/section.
    firstVisible: function (root, selector) {
      const scope = root || document;
      const els = scope.querySelectorAll(selector);
      for (let i = 0; i < els.length; i++) {
        if (window.__ymoverlay.isVisible(els[i])) return els[i];
      }
      return null;
    },
    // Finds the first element (searched across the given selector list)
    // whose visible text contains matchText (case-insensitive), and
    // clicks it. Works for YTM's popup menus, which render as an overlay
    // appended to <body> rather than nested near the button that opened
    // them - so this deliberately searches the WHOLE document rather
    // than a specific container.
    clickByText: function (selectors, matchText) {
      try {
        const needle = matchText.toLowerCase();
        const els = Array.from(document.querySelectorAll(selectors.join(",")));
        const target = els.find(function (el) {
          return (
            el.offsetParent !== null &&
            el.textContent &&
            el.textContent.trim().toLowerCase().includes(needle)
          );
        });
        if (target) {
          target.click();
          return true;
        }
        return false;
      } catch (e) {
        return false;
      }
    },
    // Same as clickByText, but scoped to a specific container instead of
    // the whole document. Whole-document text matching is unreliable for
    // menu/dialog items, since YTM's sidebar and other persistent chrome
    // often contain visually-similar text elsewhere on the page.
    clickByTextIn: function (root, selectors, matchText) {
      try {
        const needle = matchText.toLowerCase();
        const scope = root || document;
        const els = Array.from(scope.querySelectorAll(selectors.join(",")));
        const target = els.find(function (el) {
          return (
            el.offsetParent !== null &&
            el.textContent &&
            el.textContent.trim().toLowerCase().includes(needle)
          );
        });
        if (target) {
          target.click();
          return true;
        }
        return false;
      } catch (e) {
        return false;
      }
    },
    // Finds the currently-open dialog/popup, if any, so menu actions can
    // be scoped to it instead of searching the entire document.
    findDialogRoot: function () {
      return (
        document.querySelector("ytmusic-add-to-playlist-renderer") ||
        document.querySelector('tp-yt-paper-dialog[aria-hidden="false"]') ||
        document.querySelector("tp-yt-paper-dialog:not([aria-hidden='true'])") ||
        document.querySelector("tp-yt-iron-dropdown:not([aria-hidden='true'])") ||
        document
      );
    },
    // LOCALE-INDEPENDENT "..." button finder. A row's overflow/more
    // button is never identifiable by its text (it has none - just an
    // icon) or reliably by aria-label (that label IS translated per UI
    // language), so instead this leans on layout, which is not: YTM's
    // row renderer always puts the "..." button as the LAST clickable
    // icon-button in the row's own action area, in every language,
    // since it's the same component/order translated, just with
    // different displayed strings. A couple of structural attributes
    // that tend to survive redesigns are tried first as a bonus, but
    // the rightmost-icon-button rule is what actually carries this
    // across whatever language YTM is currently showing.
    findRowMenuButton: function (root) {
      const explicit =
        root.querySelector('[aria-haspopup="true"], [aria-haspopup="menu"]') ||
        root.querySelector("yt-icon-button#menu, tp-yt-paper-icon-button#menu, ytmusic-menu-renderer button");
      if (explicit && explicit.offsetParent !== null) return explicit;
      const candidates = Array.from(
        root.querySelectorAll("tp-yt-paper-icon-button, yt-icon-button, button")
      ).filter(function (b) {
        return b.offsetParent !== null;
      });
      return candidates.length ? candidates[candidates.length - 1] : null;
    },
    // LOCALE-INDEPENDENT "add to playlist" menu-item finder. The popup
    // YTM appends to <body> when a "..." button is clicked lists several
    // actions whose VISIBLE LABEL is translated but whose underlying
    // icon identifier is not (same icon set, same name, every language -
    // only the <yt-formatted-string> next to it changes). This checks
    // that icon identifier first; a small multilingual text dictionary
    // is kept only as a last-resort fallback for a redesign that
    // happens to rename the icon too, deliberately not the primary
    // signal per how fragile pure text matching proved to be here.
    findAddToPlaylistMenuItem: function (root) {
      const scope = root || document;
      const items = Array.from(
        scope.querySelectorAll(
          "ytmusic-menu-navigation-item-renderer, ytmusic-menu-service-item-renderer, tp-yt-paper-item"
        )
      ).filter(function (el) {
        return el.offsetParent !== null;
      });

      const ICON_HINTS = [
        "playlist_add",
        "playlist-add",
        "add_to_playlist",
        "addtoplaylist",
        "save_to_playlist",
        "savetoplaylist",
        "playlistadd",
      ];
      function iconSignature(el) {
        const parts = [];
        Array.from(el.querySelectorAll("yt-icon, tp-yt-iron-icon, path, use")).forEach(function (n) {
          parts.push(
            n.getAttribute("icon") || "",
            n.getAttribute("d") || "",
            n.getAttribute("href") || "",
            n.getAttribute("xlink:href") || ""
          );
        });
        return parts.join("|").toLowerCase();
      }
      let target = items.find(function (el) {
        const sig = iconSignature(el);
        return ICON_HINTS.some(function (hint) {
          return sig.indexOf(hint) !== -1;
        });
      });
      if (target) return target;

      // Last-resort fallback only - see comment above.
      const TEXT_HINTS = [
        "add to playlist", "save to playlist", // en
        "добавить в плейлист", "сохранить в плейлист", // ru
        "añadir a la lista", "guardar en la lista", // es
        "zur playlist hinzufügen", "zu playlist hinzufügen", "in playlist speichern", // de
        "ajouter à la playlist", "enregistrer dans la playlist", // fr
        "adicionar à playlist", "salvar na playlist", // pt
        "playlist'e ekle", "çalma listesine ekle", // tr
        "playlist に追加", "プレイリストに追加", // ja
        "재생목록에 추가", // ko
        "添加到播放列表", "加入播放列表", // zh
      ];
      target = items.find(function (el) {
        const t = (el.textContent || "").trim().toLowerCase();
        return TEXT_HINTS.some(function (hint) {
          return t.indexOf(hint) !== -1;
        });
      });
      return target || null;
    },
    // The volume the overlay wants (0-100). null until the overlay has
    // pushed one - see setTargetVolume below.
    targetVolume: null,
    // Whether the OVERLAY's own queue dropdown is currently open. Starts
    // true to match the overlay's default panelMode ("queue", open on
    // launch - see usePlaybackState.js) so there's no gap where queue
    // data is silently withheld before the overlay's first sync message
    // arrives. Read by tick() below to skip the entire queue scan/diff
    // (by far the most expensive thing this script does every second -
    // see readQueue()'s own comments) whenever nobody is actually
    // looking at the list, which given the panel starts closed-by-user-
    // choice most of a session, cuts that cost out almost entirely.
    queuePanelOpen: true,
    setQueuePanelOpen: function (open) {
      window.__ymoverlay.queuePanelOpen = !!open;
      // Attach/detach the queue MutationObserver (see the QUEUE SCAN
      // SCHEDULING section further down, which defines this hook).
      if (window.__ymoverlay.onQueuePanelChange) window.__ymoverlay.onQueuePanelChange(!!open);
    },
    // -----------------------------------------------------------------
    // SIDEBAR PLAYLISTS - discovery + direct playback, no navigation.
    // SINGLE SOURCE OF TRUTH: fetchPlaylists() and playPlaylist() in
    // ytmBridge.js both go through the functions below, exactly like
    // getQueueItems() is shared by readQueue() and the queue actions.
    //
    // Verified markup (devtools):
    //   ytmusic-guide-section-renderer
    //     #items
    //       ytmusic-guide-entry-renderer        <- one per sidebar row
    //         div.title-group                   <- playlist name
    //         div.subtitle-group                <- author
    //         ytmusic-play-button-renderer      <- round Play button
    //           div.content-wrapper (24x24)        (wraps yt-icon + spinner)
    // Nav rows (Home / Explore / Library ...) live in the same #items
    // container, so a row only counts as a playlist if it has a Play
    // button or an <a href="...playlist?list=..."> inside it.
    // -----------------------------------------------------------------
    maxPlaylists: 30,
    cleanText: function (el) {
      return el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "";
    },
    // Returns [{ el, index, id, href, title, author }] in sidebar
    // order. `index` is the row's position in this filtered list (same
    // numbering fetchPlaylists() sends to the overlay, before its
    // slice). `id` is the real list id when the row has a playlist link,
    // otherwise "t:<title>|<author>" (+ "#n" for the n-th identical
    // row), so two playlists with the same name never collide.
    getSidebarPlaylistEntries: function () {
      const H = window.__ymoverlay;
      const nodes = Array.from(
        document.querySelectorAll(
          "ytmusic-guide-section-renderer #items ytmusic-guide-entry-renderer"
        )
      );
      // Prefer rows that are actually laid out; only if there are none
      // (e.g. the sidebar is collapsed by a narrow window) fall back to
      // every row in the DOM - clicking a Play button doesn't need it to
      // be on screen.
      const rendered = nodes.filter(function (el) {
        return el.getClientRects().length > 0;
      });
      const source = rendered.length ? rendered : nodes;

      const out = [];
      const seen = {};
      source.forEach(function (el) {
        const anchor = el.querySelector('a[href*="playlist?list="]');
        if (!anchor && !H.findEntryPlayButton(el)) return; // nav row

        const titleEl = H.firstVisible(el, ".title-group") || el.querySelector(".title-group");
        const subtitleEl =
          H.firstVisible(el, ".subtitle-group") || el.querySelector(".subtitle-group");
        const title =
          H.cleanText(titleEl) ||
          (anchor && (anchor.getAttribute("title") || anchor.getAttribute("aria-label") || "").trim()) ||
          "";
        if (!title) return;
        const author = H.cleanText(subtitleEl);

        const href = anchor ? anchor.getAttribute("href") || "" : "";
        const m = href.match(/[?&]list=([^&#]+)/);
        let id;
        if (m) {
          id = m[1];
          if (seen[id]) return; // same playlist listed twice
          seen[id] = 1;
        } else {
          const base = "t:" + title + "|" + author;
          seen[base] = (seen[base] || 0) + 1;
          id = seen[base] > 1 ? base + "#" + seen[base] : base;
        }

        out.push({
          el: el,
          index: out.length,
          id: id,
          href: href,
          title: title,
          author: author,
        });
      });
      return out;
    },
    // Plain-data view of the above (no DOM nodes) - what crosses IPC.
    readPlaylists: function () {
      const H = window.__ymoverlay;
      return H.getSidebarPlaylistEntries()
        .slice(0, H.maxPlaylists)
        .map(function (e) {
          return { id: e.id, index: e.index, href: e.href, title: e.title, author: e.author };
        });
    },
    emitPlaylists: function () {
      try {
        window.__TAURI__.event.emit("ytm://playlists", window.__ymoverlay.readPlaylists());
      } catch (e) {}
    },
    // The click target inside a row's Play button. Tries the verified
    // tag+id, then the tag, then the class, and returns the inner
    // div.content-wrapper when present (falls back to the button host).
    // Inner-first is deliberate: a real mouse click lands on the
    // innermost element and bubbles up, so clicking the wrapper reaches
    // handlers on the wrapper AND on the host, while clicking the host
    // would skip anything bound to the wrapper. Click ONCE only - the
    // button is a play/pause toggle.
    findEntryPlayButton: function (entryEl) {
      const host =
        entryEl.querySelector("ytmusic-play-button-renderer#play-button") ||
        entryEl.querySelector("ytmusic-play-button-renderer") ||
        entryEl.querySelector(".play-button");
      if (!host) return null;
      return host.querySelector(".content-wrapper") || host;
    },
    // Dispatches the event sequence a real hover produces (enter events
    // don't bubble, as in a browser). NOTE: synthetic events do NOT
    // switch on the CSS :hover state - they only reach JS listeners.
    // Programmatic .click() doesn't depend on :hover/visibility, so the
    // hover is a best-effort nudge for any JS-driven reveal logic.
    simulateHover: function (el, on) {
      const r = el.getBoundingClientRect();
      const base = {
        cancelable: true,
        composed: true,
        view: window,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      };
      const seq = on
        ? [["pointerover", true], ["pointerenter", false], ["mouseover", true],
           ["mouseenter", false], ["pointermove", true], ["mousemove", true]]
        : [["pointerout", true], ["pointerleave", false], ["mouseout", true], ["mouseleave", false]];
      seq.forEach(function (s) {
        const init = Object.assign({ bubbles: s[1] }, base);
        try {
          el.dispatchEvent(
            s[0].indexOf("pointer") === 0
              ? new PointerEvent(s[0], Object.assign({ pointerType: "mouse", isPrimary: true }, init))
              : new MouseEvent(s[0], init)
          );
        } catch (e) {}
      });
    },
    // Re-finds a row from the overlay's { id, index } reference: the
    // remembered index is trusted only if the row at that position still
    // has the same id (the sidebar can reorder or grow between the list
    // being shown and the click); otherwise the row is looked up by id.
    resolvePlaylistEntry: function (ref) {
      const entries = window.__ymoverlay.getSidebarPlaylistEntries();
      const atIndex = entries[ref.index];
      if (atIndex && atIndex.id === ref.id) return atIndex;
      return (
        entries.find(function (e) {
          return e.id === ref.id;
        }) || null
      );
    },
    // ---- PLAY IN ORDER (playlist page) -------------------------------
    // The sidebar row's round Play button ALWAYS starts the playlist
    // shuffled (confirmed in the live DOM: it is
    // ytmusic-play-button-renderer#play-button.ytmusic-guide-entry-renderer).
    // The in-order Play button only exists on the playlist's own page, as
    // ytmusic-play-button-renderer.ytmusic-responsive-header-renderer with
    // aria-label "Play <title>" (localized: "Відтворити pls"). So
    // "Play sequentially" = click the sidebar row (YTM's own SPA navigation,
    // the row is <tp-yt-paper-item role="link">) -> wait for that page's
    // header Play -> click it -> optionally go back.
    //
    // Set to false to stay on the playlist page after starting it.
    returnAfterSequential: true,
    // Header-level Play button of the CURRENT page whose aria-label mentions
    // `title` (guards against clicking a stale header of the previous page
    // while the navigation is still in flight, or a different playlist).
    findPlaylistPagePlay: function (title) {
      const H = window.__ymoverlay;
      const selectors = [
        "ytmusic-responsive-header-renderer ytmusic-play-button-renderer",
        "ytmusic-play-button-renderer.ytmusic-responsive-header-renderer",
        "ytmusic-detail-header-renderer ytmusic-play-button-renderer",
        "ytmusic-editable-playlist-detail-header-renderer ytmusic-play-button-renderer",
        "ytmusic-immersive-header-renderer ytmusic-play-button-renderer",
      ];
      const want = (title || "").trim().toLowerCase();
      for (let i = 0; i < selectors.length; i++) {
        const host = H.firstVisible(document, selectors[i]);
        if (!host) continue;
        const label = (host.getAttribute("aria-label") || "").toLowerCase();
        if (want && label && label.indexOf(want) === -1) continue;
        return host.querySelector(".content-wrapper") || host;
      }
      return null;
    },
    playEntrySequentially: async function (entry) {
      const H = window.__ymoverlay;
      const startHref = location.href;
      entry.el.click(); // YTM's own navigation to the playlist page
      let btn = null;
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        await H.wait(120);
        btn = H.findPlaylistPagePlay(entry.title);
        if (btn) break;
      }
      if (!btn) {
        console.warn("[ymoverlay] playlist page Play button not found for:", entry.title);
        return false;
      }
      btn.click();
      if (H.returnAfterSequential && location.href !== startHref) {
        await H.wait(1000); // let the queue start before leaving the page
        try {
          history.back();
        } catch (e) {}
      }
      return true;
    },
    // Starts a playlist straight from its sidebar row:
    //   resolve row -> simulate hover -> wait for Play button -> click.
    // Never navigates. Re-entrant calls are ignored while one is running
    // (a second click on the toggle button would pause what just started).
    // If the row is gone (stale list), the fresh list is re-emitted so
    // the overlay heals itself.
    _playlistBusy: false,
    playSidebarPlaylist: async function (ref, opts) {
      const H = window.__ymoverlay;
      if (!ref || H._playlistBusy) return false;
      H._playlistBusy = true;
      // shuffle === false -> "Play sequentially"; anything else -> the row's
      // own Play button (always shuffled).
      const sequential = !!(opts && opts.shuffle === false);
      let entry = null;
      try {
        entry = H.resolvePlaylistEntry(ref);
        if (!entry) {
          console.warn("[ymoverlay] playlist not found in sidebar:", ref.title || ref.id);
          H.emitPlaylists();
          return false;
        }

        if (sequential) return await H.playEntrySequentially(entry);

        H.simulateHover(entry.el, true);
        await H.wait(30); // let hover handlers / re-renders settle

        // YTM may re-render the row after the hover; re-resolve if so.
        if (!entry.el.isConnected) {
          const again = H.resolvePlaylistEntry(ref);
          if (!again) return false;
          entry = again;
        }

        let btn = H.findEntryPlayButton(entry.el);
        const deadline = Date.now() + 800;
        while (!btn && Date.now() < deadline) {
          await H.wait(40);
          btn = H.findEntryPlayButton(entry.el);
        }
        if (!btn) {
          console.warn("[ymoverlay] Play button not found for:", entry.title);
          return false;
        }

        btn.click();
        return true;
      } catch (e) {
        console.warn("[ymoverlay] playSidebarPlaylist failed:", e);
        return false;
      } finally {
        if (entry) H.simulateHover(entry.el, false);
        H._playlistBusy = false;
      }
    },
  };
  // NOTE: trackStartOffset (defined further down, used by tick() to turn
  // the session-wide raw clock into a track-relative elapsed reading) is
  // intentionally NOT exposed here for seekTo() to consume. It's only
  // ever updated once a second, on the watcher's own poll, so by the
  // time a one-shot ytm_eval() call reads it days/moments later it can
  // already be stale relative to the exact instant of the seek - and
  // reconstructing an absolute "session time" target from a stale anchor
  // is exactly what was landing seeks in the wrong track. seekTo()
  // instead computes a RELATIVE delta against a fresh video.currentTime
  // read in the same call, the same way skip() already does reliably -
  // see ytmBridge.js.

  // -----------------------------------------------------------------
  // Volume enforcement.
  //
  // ROOT CAUSE: setting video.volume once is not enough, because YTM
  // doesn't treat the <video> element as the source of truth for volume -
  // it has its own internal player object (the same setVolume/getVolume/
  // isMuted/unMute surface as the classic YouTube IFrame Player API) which
  // periodically re-syncs the element FROM its own stored state. Whatever
  // *that* object thinks the volume is (frequently the account/site
  // default, i.e. 100) wins the next sync, which is what produces the
  // "resets to maximum roughly every 60s, and on every track change"
  // symptom - a track change goes further and swaps in a whole new
  // <video> node that boots at its own default, ignoring whatever we'd
  // set on the previous one entirely.
  //
  // FIX: don't just fight the symptom on the <video> element - update
  // YTM's own player object every time we detect drift too, so its next
  // internal sync reads back OUR value instead of re-queuing another
  // reset. This is reapplied on a tight interval AND on the element's own
  // "volumechange" event (native, fires synchronously whenever anything -
  // us or YTM - assigns video.volume), so a reset is corrected within
  // effectively one animation frame rather than being audible.
  // -----------------------------------------------------------------

  function getPlayerApi() {
    const el =
      document.querySelector("#movie_player") ||
      document.querySelector("ytmusic-player");
    return el && typeof el.setVolume === "function" ? el : null;
  }

  function applyTargetVolume() {
    const target = window.__ymoverlay.targetVolume;
    if (target === null) return;

    const video = document.querySelector("video");
    const targetFraction = target / 100;

    // Update YTM's own player object first - this is what stops it from
    // re-scheduling another reset, not just correcting the current one.
    try {
      const player = getPlayerApi();
      if (player) {
        const current = player.getVolume ? player.getVolume() : null;
        if (current === null || Math.abs(current - target) > 0.5) {
          player.setVolume(target);
        }
        if (target > 0 && player.isMuted && player.isMuted() && player.unMute) {
          player.unMute();
        }
      }
    } catch (e) {}

    // Then the raw element, in case anything reads/writes it directly
    // without going through the player object.
    try {
      if (video) {
        if (Math.abs(video.volume - targetFraction) > 0.01) {
          video.volume = targetFraction;
        }
        if (video.muted && target > 0) {
          video.muted = false;
        }
      }
    } catch (e) {}

    // EXPERIMENTAL best-effort: YouTube's web players persist volume to
    // localStorage (historically under "yt-player-volume", a JSON blob
    // like {"data":"{\"volume\":N,\"muted\":false}",...}) and some of
    // their internal sync paths read FROM that key rather than only from
    // the in-memory player object. Keeping it aligned with our target
    // closes off that reset source too, where present. Wrapped entirely
    // in try/catch and never trusted as the primary mechanism, since the
    // exact key/shape isn't a public API and may not match every build.
    try {
      const raw = window.localStorage.getItem("yt-player-volume");
      if (raw) {
        const outer = JSON.parse(raw);
        const inner = JSON.parse(outer.data);
        if (inner && (inner.volume !== target || inner.muted)) {
          inner.volume = target;
          inner.muted = target === 0;
          outer.data = JSON.stringify(inner);
          window.localStorage.setItem("yt-player-volume", JSON.stringify(outer));
        }
      }
    } catch (e) {}
  }

  let lastVolumeWatchedVideo = null;
  function watchVideoElement() {
    const video = document.querySelector("video");
    if (video && video !== lastVolumeWatchedVideo) {
      lastVolumeWatchedVideo = video;
      try {
        // Native event, fires synchronously on ANY assignment to
        // video.volume - ours or YTM's - so this is the fast path for
        // catching a mid-track reset the instant it happens rather than
        // waiting for the next poll.
        video.addEventListener("volumechange", applyTargetVolume);
      } catch (e) {}
      // A track change swaps in a brand new element that boots at ITS
      // OWN default - correct it immediately rather than waiting for the
      // next interval tick.
      applyTargetVolume();
    }
  }

  window.__ymoverlay.setTargetVolume = function (percent) {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    window.__ymoverlay.targetVolume = clamped;
    applyTargetVolume();
  };

  // Defensive: block the handful of keys YTM's own UI uses as volume
  // shortcuts (mute, arrow up/down) from ever reaching its handlers.
  // This hidden window normally receives no real keyboard focus, so
  // this is a low-cost backstop rather than the main fix - the interval
  // + volumechange enforcement above is what actually keeps the level
  // locked regardless of what triggers a drift.
  window.addEventListener(
    "keydown",
    function (e) {
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) return;
      const key = (e.key || "").toLowerCase();
      if (key === "m" || key === "arrowup" || key === "arrowdown") {
        e.stopPropagation();
      }
    },
    true
  );

  // Independent of the 500ms UI tick, and deliberately tight - the reset
  // this guards against isn't tied to our tick cadence, and the goal is
  // for a drift to be corrected within a couple hundred ms, not be
  // audible. Gated to actual playback: paused audio can't audibly drift,
  // so polling then is pure waste - and YTM's periodic re-sync is what
  // this is guarding against in the first place, which only matters
  // while sound is actually coming out.
  setInterval(function () {
    const video = document.querySelector("video");
    if (!video || video.paused) return;
    watchVideoElement();
    applyTargetVolume();
  }, 200);

  function textOf(el) {
    return el ? el.textContent.trim() : "";
  }

  // PLAYER-BAR READS: scoped + cached.
  // The old code ran document-wide selectors ("ytmusic-player-bar .title,
  // .ytmusic-player-bar .title" etc.) 4x per check and then called
  // offsetParent on every match - every `.title` on the whole YTM page
  // was a candidate, and each offsetParent read could force a full
  // layout. Measured on a synthetic 11k/16k/36k-node page: 3.4 / 10 /
  // 25 ms per check, vs 0.2 / 0.2 / 0.5 ms scoped to the bar.
  // The bar is a single element, so it and its fields are cached and
  // only re-resolved when they detach (Polymer re-stamping) or the
  // cached copy stops being the visible one (desktop/mobile duplicate
  // swap, see firstVisible's own comment). Re-resolution still goes
  // through firstVisible(), so the hidden-duplicate protection is intact.
  let cachedBar = null;
  const barFields = {};
  function getPlayerBar() {
    if (cachedBar && cachedBar.isConnected) return cachedBar;
    cachedBar = document.querySelector("ytmusic-player-bar");
    for (const k in barFields) delete barFields[k];
    return cachedBar;
  }
  function barField(key, selector) {
    const bar = getPlayerBar();
    if (!bar) return null;
    const cached = barFields[key];
    if (cached && bar.contains(cached) && window.__ymoverlay.isVisible(cached)) return cached;
    const found = window.__ymoverlay.firstVisible(bar, selector);
    barFields[key] = found;
    return found;
  }

  // DURATION NOTE: video.duration is not reliable for "how long is this
  // track" either - during a track transition it can briefly reflect the
  // previous/next track's length or a combined/buffered value rather than
  // the currently-playing song's own length (this is what produced the
  // screenshot bug: footer showed 2:57, overlay showed ~4:41). The player
  // bar's own time-info footer text (e.g. "0:16 / 2:57") is what YTM's UI
  // itself displays as the source of truth, so that's what we parse - the
  // part after the "/" is the total length, in minutes:seconds (or
  // hours:minutes:seconds), which we convert to plain seconds.
  function parseTimeToSeconds(text) {
    if (!text) return 0;
    const parts = text.trim().split(":").map(Number);
    if (parts.length === 0 || parts.some((p) => !isFinite(p))) return 0;
    let seconds = 0;
    for (let i = 0; i < parts.length; i++) {
      seconds = seconds * 60 + parts[i];
    }
    return seconds;
  }

  // Reads the total track length from the player bar's footer time text
  // rather than the <video> element. rawFallback (video.duration, if any)
  // is used only as a last resort, if the footer isn't found/parseable
  // yet (e.g. DOM not settled on this exact tick) - it is never the
  // primary source.
  function readFooterDuration(rawFallback) {
    const timeEl = barField("time", ".time-info");
    const text = textOf(timeEl); // e.g. "0:16 / 2:57"
    const totalText = text.indexOf("/") >= 0 ? text.split("/")[1] : text;
    const seconds = parseTimeToSeconds(totalText);
    return seconds > 0 ? seconds : rawFallback;
  }

  function readTick() {
    const video = document.querySelector("video");
    const rawDuration = video && isFinite(video.duration) ? video.duration : 0;
    return {
      isPlaying: video ? !video.paused : false,
      currentTime: video ? video.currentTime : 0,
      duration: readFooterDuration(rawDuration),
      volume: video ? video.volume : 1,
    };
  }

  function readTrack() {
    const titleEl = barField("title", ".title");
    const bylineEl = barField("byline", ".byline");
    const artEl = barField("art", "img.image, img");

    // byline is usually "Artist • Album • Year" - first segment is the artist
    const artist = textOf(bylineEl).split("•")[0].trim();

    return {
      title: textOf(titleEl) || null,
      artist: artist || null,
      art: artEl ? artEl.src : null,
    };
  }

  // QUEUE POOL LIMITS.
  // getQueueItems() returns EVERY <ytmusic-player-queue-item> currently
  // mounted, in document order - both already-played (history) and
  // upcoming tracks around whichever one is marked "selected". Left
  // uncapped, that raw list can grow as large as YTM's own queue panel
  // does over a long session or as the user scrolls it (YTM lazily mounts
  // more rows), which is exactly the "interface freezes" risk: every
  // tick would walk and diff a growing NodeList forever.
  //   - MAX_HISTORY_TRACKS  - how many already-played tracks to show
  //                           behind the active one.
  //   - MAX_FORWARD_TRACKS  - how many upcoming tracks to show ahead of
  //                           the active one.
  //   - MAX_POOL_SIZE       - independent of the two display limits
  //                           above: the hard ceiling on how many raw
  //                           DOM nodes from getQueueItems() this
  //                           function will even look at in a single
  //                           tick, windowed around the active item. This
  //                           is what actually bounds memory/CPU when
  //                           YTM's own list has grown huge from
  //                           scrolling - the display limits alone
  //                           wouldn't, since they're applied AFTER
  //                           reading every row's title/byline/art.
  const MAX_HISTORY_TRACKS = 6;
  const MAX_FORWARD_TRACKS = 10;
  const MAX_POOL_SIZE = 30;

  function readQueue() {
    try {
      // TRUE indices into this array are what ytmBridge.js's
      // selectQueueItem()/addQueueItemToPlaylist() index against (they
      // call getQueueItems() fresh themselves) - so every emitted row's `id` below must stay the row's real position HERE,
      // never a position renumbered after windowing/slicing, or clicks
      // land on the wrong track (the exact "off-by-one" class of bug
      // getQueueItems()'s own filtering was written to prevent).
      const rawItems = window.__ymoverlay.getQueueItems();

      const activeIndex = rawItems.findIndex(
        (el) => el.hasAttribute("selected") || el.classList.contains("selected")
      );

      // Clamp how much of the raw list we even walk, before doing any
      // per-row DOM reads. Centered on the active item when known, so a
      // huge history built up over a long session never crowds the
      // upcoming tracks out of the window (or vice versa).
      let windowStart = 0;
      let windowEnd = rawItems.length;
      if (rawItems.length > MAX_POOL_SIZE) {
        if (activeIndex === -1) {
          windowEnd = MAX_POOL_SIZE;
        } else {
          windowStart = Math.max(0, activeIndex - MAX_HISTORY_TRACKS - 2);
          windowEnd = Math.min(rawItems.length, windowStart + MAX_POOL_SIZE);
          windowStart = Math.max(0, windowEnd - MAX_POOL_SIZE);
        }
      }
      const pooled = rawItems.slice(windowStart, windowEnd);
      const activeIndexInPool = activeIndex === -1 ? -1 : activeIndex - windowStart;

      // Now apply the two DISPLAY limits within that pooled window.
      let sliceStart;
      let sliceEnd;
      if (activeIndexInPool === -1) {
        // No selected row found (rare - e.g. mid-transition) - fall back
        // to the old behavior of just showing up to MAX_FORWARD_TRACKS
        // from the front, no history, rather than showing nothing.
        sliceStart = 0;
        sliceEnd = Math.min(pooled.length, MAX_FORWARD_TRACKS);
      } else {
        sliceStart = Math.max(0, activeIndexInPool - MAX_HISTORY_TRACKS);
        sliceEnd = Math.min(pooled.length, activeIndexInPool + 1 + MAX_FORWARD_TRACKS);
      }

      // NOTE: deliberately not reading each row's <img> here. The queue
      // list UI is text-only (see QueueRow.jsx) - it never displays these
      // thumbnails, so reading/serializing/diffing them on every 1s tick
      // would be pure overhead: an extra DOM query per pooled row, plus a
      // (usually data-URL-sized) string in queueSig's comparison and in
      // the payload sent across the Tauri IPC bridge. Skipping it here is
      // what actually removes the cost, not just hiding the <img> in CSS.
      return pooled.slice(sliceStart, sliceEnd).map((el, i) => {
        const trueIndex = windowStart + sliceStart + i;
        const titleEl = window.__ymoverlay.firstVisible(el, ".song-title, .title");
        const bylineEl = window.__ymoverlay.firstVisible(el, ".byline");
        return {
          id: String(trueIndex),
          title: textOf(titleEl) || "Unknown title",
          artist: textOf(bylineEl).split("•")[0].trim(),
          active:
            el.hasAttribute("selected") || el.classList.contains("selected"),
        };
      });
    } catch (e) {
      return [];
    }
  }

  // Drives the ytm://track UI event (art included, since a thumbnail can
  // refresh without the song actually changing and we still want the new
  // image to reach the overlay).
  let lastTrackSig = "";
  // Drives the HARD TIMER RESET only. Deliberately narrower than
  // lastTrackSig (title/artist only) - an art-only refresh must not zero
  // the timer, only an actual song change should.
  let lastTrackKey = "";
  let lastQueueSig = "";

  // ROOT CAUSE of the "previous song's seconds bleed into the next one"
  // bug: YTM does NOT reset <video>.currentTime to 0 at the start of each
  // queued track - it runs one continuous, non-resetting clock on the
  // element across the whole gapless session (readTick()'s currentTime
  // keeps climbing straight through a track change). So the DOM's raw
  // currentTime is NOT "seconds into this track" - it's "seconds into
  // the whole session". Trusting it directly (even just resetting the
  // DISPLAY to 0 for one tick and relaying the raw value again on the
  // next) is exactly what caused the timer to jump back up to the
  // accumulated total a tick after the reset.
  //
  // FIX: don't display the raw value at all. The instant a new track is
  // detected, remember the raw currentTime AT THAT MOMENT as this
  // track's start offset. Every following tick for that same track
  // subtracts that offset from the fresh raw reading to get seconds
  // elapsed IN THIS TRACK. This is still a single fresh DOM read per
  // tick with one subtraction - not a local clock, not an accumulating
  // delta - it's just "where did THIS song start counting from".
  let trackStartOffset = 0;

  // -----------------------------------------------------------------
  // TRACK DESYNC FIX: the 1-second poll below is normally enough on its
  // own, but changing tracks by clicking directly inside YTM's own UI
  // (as opposed to this overlay's next/prev/queue-select, which stays
  // within YTM's existing queue-advance path) can drive a heavier
  // update on the player bar - title/byline nodes swapped for new
  // elements, art needing to load, possibly more than one transient
  // state before it settles. If the poll's one snapshot a second
  // happens to land mid-transition, there's nothing to compare against
  // until a full second later - usually still fine, but if settling
  // takes long enough, several polls in a row can each sample a
  // still-transient value and never notice the real change.
  //
  // FIX: don't rely on the poll ALONE to catch the moment things
  // settle - also watch the player bar's own title/byline nodes with a
  // MutationObserver, and re-run the exact same check the instant YTM
  // itself writes new text there, regardless of which code path
  // triggered it. The 1-second poll stays as the safety net (covers
  // e.g. a markup change the observer's selectors miss); the observer
  // is what makes detection immune to HOW LONG YTM takes to settle,
  // since it reacts to the real mutation whenever it actually happens
  // instead of guessing when to sample next.
  // -----------------------------------------------------------------
  let trackObserverTarget = null;
  let trackObserverScheduled = false;
  // The ONLY thing in the bar that mutates every second is the
  // "0:16 / 2:57" text. It can never change which track is playing, so
  // records that only touch it are dropped - otherwise the observer was
  // just a second 1 Hz poll (plus a duplicate ytm://tick per second).
  function isTimerNoise(rec) {
    let n = rec.target;
    if (n && n.nodeType === 3) n = n.parentNode;
    return !!(n && n.closest && n.closest(".time-info"));
  }
  function ensureTrackObserver() {
    const bar = getPlayerBar();
    if (!bar || bar === trackObserverTarget) return;
    trackObserverTarget = bar;
    const observer = new MutationObserver(function (records) {
      const __diagStart = window.__ymoverlay._diag ? nowMs() : 0;
      let relevant = false;
      for (let i = 0; i < records.length; i++) {
        if (!isTimerNoise(records[i])) {
          relevant = true;
          break;
        }
      }
      if (window.__ymoverlay._diag) {
        const __d = nowMs() - __diagStart;
        if (__d > 50) {
          console.warn("[ymoverlay] trackObserver filter " + Math.round(__d) + "ms, " + records.length + " records, visibility=" + document.visibilityState);
        }
      }
      if (!relevant) return;
      // Mutations arrive in bursts (several nodes can change as part of
      // the same visual update) - coalesce a burst into a single
      // re-check via rAF instead of re-running it once per record.
      if (trackObserverScheduled) return;
      trackObserverScheduled = true;
      (window.requestAnimationFrame || setTimeout)(function () {
        trackObserverScheduled = false;
        checkTrackAndTimer(true);
      });
    });
    // Deliberately still on the whole bar (not just the title node):
    // Polymer can swap the title/byline nodes for new ones, and an
    // observer pinned to the old node would go silent - the exact
    // desync this observer exists to fix.
    observer.observe(bar, { childList: true, subtree: true, characterData: true });
  }

  // --- track + timer, read together and gated as one unit -------------
  // Both come from the same DOM pass on purpose: the whole point of the
  // gate below is to compare THIS check's title against last check's
  // title before deciding how to interpret THIS check's raw
  // currentTime. Called both from the 1-second poll and from
  // ensureTrackObserver()'s MutationObserver above, so it must stay
  // side-effect-safe to call more than once for what turns out to be
  // the same, unchanged state (the trackKey/trackSig diffs below
  // already guarantee that - a redundant call this same tick is just a
  // few DOM reads, not a duplicate event).
  // `fromObserver` = called by the MutationObserver rather than the 1 Hz
  // poll: then a same-track check emits no ytm://tick (the poll sends
  // one within a second anyway); a track change still does, at once.
  function checkTrackAndTimer(fromObserver) {
    try {
      const track = readTrack();
      const trackKey = track.title + "|" + track.artist;

      if (trackKey !== lastTrackKey) {
        const raw = readTick(); // isPlaying/currentTime(raw)/duration/volume
        // New song. Anchor here - whatever the player's own (continuous)
        // clock reads right now becomes "0" for this track - and forcibly
        // report 0, never any part of the previous track's elapsed time.
        lastTrackKey = trackKey;
        trackStartOffset = raw.currentTime;
        window.__TAURI__.event.emit("ytm://tick", {
          isPlaying: raw.isPlaying,
          currentTime: 0,
          duration: raw.duration,
          volume: raw.volume,
        });
      } else if (!fromObserver) {
        const raw = readTick();
        // Same song as last check - elapsed-in-this-track is just the
        // fresh raw reading minus the offset captured when it started.
        // Math.max guards the rare tick where raw briefly dips below the
        // offset (e.g. a buffering hiccup) so the display never goes
        // negative.
        const elapsed = Math.max(0, raw.currentTime - trackStartOffset);
        window.__TAURI__.event.emit("ytm://tick", {
          isPlaying: raw.isPlaying,
          currentTime: elapsed,
          duration: raw.duration,
          volume: raw.volume,
        });
      }

      const trackSig = trackKey + "|" + track.art;
      if (trackSig !== lastTrackSig) {
        lastTrackSig = trackSig;
        window.__TAURI__.event.emit("ytm://track", track);
      }
    } catch (e) {
      /* DOM not ready yet - ignore, retry next tick */
    }
  }

  // -----------------------------------------------------------------
  // QUEUE SCAN SCHEDULING.
  // The queue scan (getQueueItems + per-row reads) is by far the most
  // expensive thing here - on a long session YTM never unmounts old rows,
  // so the raw list can reach hundreds/thousands, and the scan pays a
  // style/layout flush for them (measured 2 / 8 / 22 ms, p95 up to 50 ms,
  // at 300 / 1500 / 4000 rows). The queue almost never changes, so it is
  // no longer scanned on a fixed 1 Hz clock. Instead:
  //   - a MutationObserver on YTM's queue container (childList/text +
  //     the `selected` attribute) requests a scan when something changed;
  //   - requests are coalesced (QUEUE_DEBOUNCE_MS) and rate-limited to
  //     one scan per QUEUE_MIN_INTERVAL_MS, so a burst of mutations (YTM
  //     lazily mounting rows) can never scan more often than the old poll;
  //   - a slow safety poll (every QUEUE_SAFETY_TICKS ticks) covers
  //     anything the observer can't see (e.g. a class-only change);
  //   - ADAPTIVE BACKOFF kept: a scan slower than 80ms pushes the next
  //     allowed scan out proportionally (max 10 s);
  //   - nothing is observed or scanned while the overlay's queue panel is
  //     closed (queuePanelOpen), same gate as before.
  // -----------------------------------------------------------------
  const QUEUE_DEBOUNCE_MS = 200;
  const QUEUE_MIN_INTERVAL_MS = 1000;
  const QUEUE_SAFETY_TICKS = 5;
  let queueTimer = null;
  let queueNextAllowedAt = 0;
  let queueObserver = null;
  let queueObserved = null;

  function nowMs() {
    return window.performance && performance.now ? performance.now() : Date.now();
  }

  function runQueueScan() {
    queueTimer = null;
    if (window.__ymoverlay.queuePanelOpen === false) return;
    try {
      const start = nowMs();
      const queue = readQueue();
      const elapsed = nowMs() - start;
      if (window.__ymoverlay._diag && elapsed > 50) {
        console.warn("[ymoverlay] runQueueScan " + Math.round(elapsed) + "ms, " + queue.length + " rows, visibility=" + document.visibilityState);
      }
      const backoff = elapsed > 80 ? Math.min(10, Math.ceil(elapsed / 80)) * 1000 : 0;
      queueNextAllowedAt = nowMs() + Math.max(QUEUE_MIN_INTERVAL_MS, backoff);
      const queueSig = queue
        .map((t) => t.id + t.title + t.active)
        .join(";");
      if (queueSig !== lastQueueSig) {
        lastQueueSig = queueSig;
        window.__TAURI__.event.emit("ytm://queue", queue);
      }
    } catch (e) {
      /* queue panel DOM not ready - ignore */
    }
  }

  function scheduleQueueRead(immediate) {
    if (window.__ymoverlay.queuePanelOpen === false) return;
    if (queueTimer !== null) {
      if (!immediate) return;
      clearTimeout(queueTimer);
    }
    const delay = immediate ? 0 : Math.max(QUEUE_DEBOUNCE_MS, queueNextAllowedAt - nowMs());
    queueTimer = setTimeout(runQueueScan, delay);
  }

  function disconnectQueueObserver() {
    if (queueObserver) queueObserver.disconnect();
    queueObserved = null;
    if (queueTimer !== null) {
      clearTimeout(queueTimer);
      queueTimer = null;
    }
  }

  // Cheap to call every tick: when already attached to a live container
  // it is a single isConnected check.
  function ensureQueueObserver() {
    if (window.__ymoverlay.queuePanelOpen === false) {
      disconnectQueueObserver();
      return;
    }
    if (queueObserved && queueObserved.isConnected) return;
    const container = window.__ymoverlay.getQueueContainer();
    // getQueueContainer() returns `document` when YTM hasn't mounted the
    // queue yet - never observe that; the safety poll keeps checking.
    if (container === document) return;
    if (!queueObserver) {
      queueObserver = new MutationObserver(function (records) {
        if (window.__ymoverlay._diag && records.length > 200) {
          console.warn("[ymoverlay] queueObserver batch " + records.length + " records, visibility=" + document.visibilityState);
        }
        scheduleQueueRead(false);
      });
    }
    queueObserver.disconnect();
    queueObserver.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["selected"],
    });
    queueObserved = container;
    scheduleQueueRead(true); // fresh container: read it right away
  }

  window.__ymoverlay.onQueuePanelChange = function (open) {
    if (open) {
      ensureQueueObserver();
      scheduleQueueRead(true);
    } else {
      disconnectQueueObserver();
    }
  };

  let tickCount = 0;
  function tick() {
    const diag = window.__ymoverlay._diag;
    let t0 = diag ? nowMs() : 0;

    ensureTrackObserver();
    if (diag) {
      const d = nowMs() - t0;
      if (d > 50) console.warn("[ymoverlay] tick/ensureTrackObserver " + Math.round(d) + "ms, visibility=" + document.visibilityState);
      t0 = nowMs();
    }

    checkTrackAndTimer(false);
    if (diag) {
      const d = nowMs() - t0;
      if (d > 50) console.warn("[ymoverlay] tick/checkTrackAndTimer " + Math.round(d) + "ms, visibility=" + document.visibilityState);
      t0 = nowMs();
    }

    try {
      ensureQueueObserver();
      if (diag) {
        const d = nowMs() - t0;
        if (d > 50) console.warn("[ymoverlay] tick/ensureQueueObserver " + Math.round(d) + "ms, visibility=" + document.visibilityState);
        t0 = nowMs();
      }
      if (window.__ymoverlay.queuePanelOpen !== false && tickCount % QUEUE_SAFETY_TICKS === 0) {
        scheduleQueueRead(false);
      }
    } catch (e) {
      /* queue DOM not ready - ignore */
    }
    tickCount++;
  }

  // OPT-IN DIAGNOSTICS for chasing the remaining freezes. Off by default
  // (zero cost). In devtools of the "main" window run:
  //   window.__ymoverlay.enableDiagnostics()
  // Logs (a) any main-thread task > 50ms, and (b) timer drift > 300ms -
  // each with document.visibilityState, which tells a BLOCKED thread
  // (long task) from a THROTTLED/hidden window (drift, no long task,
  // visibilityState "hidden") - plus JS heap size every ~30s to spot GC
  // pressure / leaks.
  window.__ymoverlay.enableDiagnostics = function () {
    if (window.__ymoverlay._diag) return;
    window.__ymoverlay._diag = true;
    try {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (e) {
          console.warn("[ymoverlay] long task " + Math.round(e.duration) + "ms, visibility=" + document.visibilityState);
        });
      }).observe({ entryTypes: ["longtask"] });
    } catch (e) {}
    let last = nowMs();
    let n = 0;
    setInterval(function () {
      const t = nowMs();
      const drift = t - last - 500;
      last = t;
      if (drift > 300) {
        console.warn("[ymoverlay] timer drift " + Math.round(drift) + "ms, visibility=" + document.visibilityState);
      }
      if (++n % 60 === 0 && performance.memory) {
        console.log("[ymoverlay] heap " + Math.round(performance.memory.usedJSHeapSize / 1048576) + "MB");
      }
    }, 500);
    console.log("[ymoverlay] diagnostics on");
  };

  // Classic 1-second poll. No performance.now(), no local clock, no
  // running total we add to ourselves - each tick just reads the DOM
  // fresh and subtracts a fixed per-track offset. See ROOT CAUSE note
  // above tick().
  setInterval(tick, 1000);
  tick();
})();
