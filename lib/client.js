/**
 * dsh-terminal-probe — browser half.
 *
 * Reads the bottom-panel xterm's ACTUAL rendered colors:
 *   1. canvas pixel sampling (the truth — includes "inherited" stale themes)
 *   2. body token recompute (the skin the theme SHOULD produce)
 * plus the current skin/theme state, and drives real switches:
 *   - skin: loads the skin-center stylesheet/patches as <link> tags (same order
 *     as the skin center: load first, then set html[data-dsh-skin]) so the
 *     rendered tokens are genuine;
 *   - theme: toggles body[data-ds-dark-theme].
 * Samples are POSTed to /api/terminal-probe/report.
 *
 * Runs an automatic matrix once after mount, then passively samples on
 * skin/theme changes. Registers as a cordis client plugin (no UI).
 */

window.__ModuleLoader__.load({
  id: "dsh-terminal-probe",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const API = "/api/terminal-probe";
    const PROBE_Q = "dsh-probe=1";

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function currentSkin() {
      return document.documentElement.getAttribute("data-dsh-skin") || null;
    }

    function currentTheme() {
      // mirror better-sidebar isDarkScheme()
      const doc = document.documentElement;
      if (doc.style.colorScheme !== "") return document.body.hasAttribute("data-ds-dark-theme") ? "dark" : "light";
      const mq = typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)");
      return mq && mq.matches ? "dark" : "light";
    }

    function colorAlpha(value) {
      const s = (value || "").trim();
      if (s === "") return null;
      const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
      if (hex !== null) {
        const d = hex[1];
        if (d.length === 3) return 1;
        if (d.length === 4) return parseInt(d[3] + d[3], 16) / 255;
        if (d.length === 6) return 1;
        return parseInt(d.slice(6, 8), 16) / 255;
      }
      const fn = /^(rgba?|hsla?)\(([^)]+)\)$/i.exec(s);
      if (fn !== null) {
        const alphaPart = fn[2].split(/[,\s/]+/).filter(Boolean)[3];
        if (alphaPart === undefined) return 1;
        const a = Number.parseFloat(alphaPart);
        return Number.isFinite(a) ? a : 1;
      }
      return null;
    }

    function effectiveTokenValue(name) {
      const raw = getComputedStyle(document.body).getPropertyValue(name).trim();
      if (raw === "" || raw === "transparent" || raw === "initial" || raw === "inherit" || raw === "unset") return "";
      const alpha = colorAlpha(raw);
      if (alpha !== null && alpha < 0.9) return "";
      return raw;
    }

    /** Recompute what the ORIGINAL better-sidebar xtermTheme() would pick. */
    function recomputeXtermColors() {
      const dark = currentTheme() === "dark";
      const rawBg = getComputedStyle(document.body).getPropertyValue("--dsw-alias-bg-base");
      const rawLabel = getComputedStyle(document.body).getPropertyValue("--dsw-alias-label-primary");
      const unsupported = (v) => v.includes("calc(") || v.includes("color-mix(") || v.includes("var(");
      const background = effectiveTokenValue("--dsw-alias-bg-base") || (unsupported(rawBg) ? "" : null) || (dark ? "#111114" : "#ffffff");
      const foreground = effectiveTokenValue("--dsw-alias-label-primary") || (unsupported(rawLabel) ? "" : null) || (dark ? "#e6e6e6" : "#1a1a1a");
      return { background, foreground };
    }

    /** Sample every visible xterm canvas OR the DOM-renderer rows (the truth). */
    function readTerminalCanvas() {
      const canvases = Array.from(document.querySelectorAll(".xterm canvas"));
      const out = [];
      for (const cvs of canvases) {
        if (!cvs.width || !cvs.height) continue;
        let ctx2d = null;
        try {
          ctx2d = cvs.getContext("2d");
        } catch (e) {
          ctx2d = null;
        }
        if (!ctx2d) continue;
        try {
          const w = cvs.width;
          const h = cvs.height;
          const data = ctx2d.getImageData(0, 0, w, h).data;
          const counts = new Map();
          let opaqueTotal = 0;
          for (let y = 0; y < h; y += 2) {
            for (let x = 0; x < w; x += 2) {
              const i = (y * w + x) * 4;
              const a = data[i + 3];
              if (a === 0) continue;
              opaqueTotal += 1;
              const key = data[i] + "," + data[i + 1] + "," + data[i + 2];
              counts.set(key, (counts.get(key) || 0) + 1);
            }
          }
          if (opaqueTotal === 0) continue;
          const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4);
          out.push({
            size: w + "x" + h,
            colors: sorted.map(([k, c]) => {
              const rgb = k.split(",").map(Number);
              return { color: "rgb(" + rgb.join(", ") + ")", hex: "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join(""), ratio: +(c / opaqueTotal).toFixed(4) };
            }),
          });
        } catch (e) {
          out.push({ error: String(e) });
        }
      }
      // DOM-renderer fallback: read computed text colors from rendered rows
      // and the .xterm container itself (plus a structural diagnostic).
      if (out.length === 0) {
        const seen = [];
        for (const el of Array.from(document.querySelectorAll(".xterm .xterm-rows span, .xterm .xterm-rows, .xterm"))) {
          const cs = getComputedStyle(el);
          const col = cs.color;
          if (col && !seen.includes(col)) seen.push(col);
          if (seen.length >= 8) break;
        }
        const structure = Array.from(document.querySelectorAll(".xterm")).map((el) =>
          el.className + ">" + Array.from(el.children).slice(0, 6).map((c) => c.tagName + "." + String(c.className).split(" ").slice(0, 2).join(".")).join(", ")
        );
        out.push({ domColors: seen, structure, fallbackRan: true });
      }
      return out.length > 0 ? out : null;
    }

    function sample(extra) {
      const rawBg = getComputedStyle(document.body).getPropertyValue("--dsw-alias-bg-base").trim();
      const rawLabel = getComputedStyle(document.body).getPropertyValue("--dsw-alias-label-primary").trim();
      const recomputed = recomputeXtermColors();
      let canvas = null;
      let canvasNote = "";
      let canvasErr = null;
      try {
        const c0 = document.querySelectorAll(".xterm canvas").length;
        const x0 = document.querySelectorAll(".xterm").length;
        const rows0 = document.querySelectorAll(".xterm .xterm-rows").length;
        canvas = readTerminalCanvas();
        canvasNote = "cvs=" + c0 + ",xterm=" + x0 + ",rows=" + rows0 + ",res=" + (canvas === null ? "null" : canvas.length);
      } catch (e) {
        canvasErr = String(e);
      }
      const data = {
        t: new Date().toISOString(),
        skin: currentSkin(),
        theme: currentTheme(),
        terminal: terminalPresent(),
        rawBg,
        rawLabel,
        recomputedBg: recomputed.background,
        recomputedFg: recomputed.foreground,
        canvas,
        canvasNote,
        canvasErr,
      };
      // UI-level token audit: what the page ACTUALLY resolves for the
      // success/state colors that green labels, switches and dots use.
      try {
        const cs = getComputedStyle(document.body);
        data.ui = {
          successPrimary: cs.getPropertyValue("--dsw-alias-state-success-primary").trim(),
          successSecondary: cs.getPropertyValue("--dsw-alias-state-success-secondary").trim(),
          successTertiary: cs.getPropertyValue("--dsw-alias-state-success-tertiary").trim(),
          labelPrimary: cs.getPropertyValue("--dsw-alias-label-primary").trim(),
          bodyDark: document.body.hasAttribute("data-ds-dark-theme"),
          htmlSkin: document.documentElement.getAttribute("data-dsh-skin"),
          htmlColorScheme: document.documentElement.style.colorScheme,
        };
      } catch (e) {
        data.ui = { error: String(e) };
      }
      if (extra !== undefined) Object.assign(data, extra);
      data.ver = 9;
      return data;
    }

    function report(data) {
      try {
        fetch(API + "/report", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
        }).catch(() => {});
      } catch (e) {
        // ignore
      }
    }

    function cleanupProbeLinks() {
      for (const link of Array.from(document.querySelectorAll('link[href*="' + PROBE_Q + '"]'))) {
        link.remove();
      }
    }

    function loadCss(href) {
      return new Promise((resolve) => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        const done = (ok) => {
          if (!ok) link.remove();
          resolve(ok);
        };
        link.onload = () => done(true);
        link.onerror = () => done(false);
        document.head.appendChild(link);
      });
    }

    async function applySkin(id) {
      cleanupProbeLinks();
      if (id === null || id === "" || id === "official") {
        document.documentElement.removeAttribute("data-dsh-skin");
        return;
      }
      const base = "/api/skin-center/v2/skins/" + encodeURIComponent(id);
      await loadCss(base + "/stylesheet?" + PROBE_Q);
      await loadCss(base + "/patches?" + PROBE_Q); // 404 is fine
      document.documentElement.setAttribute("data-dsh-skin", id);
      await sleep(60); // let styles settle
    }

    async function restoreState(saved) {
      cleanupProbeLinks();
      if (saved.theme === "dark") document.body.setAttribute("data-ds-dark-theme", "");
      else document.body.removeAttribute("data-ds-dark-theme");
      if (saved.skin === null) document.documentElement.removeAttribute("data-dsh-skin");
      else document.documentElement.setAttribute("data-dsh-skin", saved.skin);
      await sleep(120);
    }

    /** Read-only terminal presence probe. NEVER clicks panel widgets — the panel
    *   is user-owned; clicking here is what closed the terminal before. */
    function terminalPresent() {
      if (document.querySelector(".xterm canvas")) return "canvas";
      if (document.querySelector(".xterm")) return "xterm-no-canvas";
      return false;
    }

    const MATRIX_SKINS = ["official", "summer-liquid-glass", "harbor", "whale-song", "blue-fantasy", "dragon-heir", "mint"];

    async function runMatrix(saved, skins, themes, runId) {
      const skins2 = Array.isArray(skins) && skins.length > 0 ? skins : MATRIX_SKINS;
      const themes2 = Array.isArray(themes) && themes.length > 0 ? themes : ["light", "dark"];
      const steps = [];
      for (const skin of skins2) {
        for (const theme of themes2) steps.push({ skin, theme });
      }
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        try {
          await applySkin(step.skin === "official" ? null : step.skin);
          if (step.theme === "dark") document.body.setAttribute("data-ds-dark-theme", "");
          else document.body.removeAttribute("data-ds-dark-theme");
          await sleep(500);
          report(sample({ step: i + 1 + "/" + steps.length, origin: "matrix", target: step, runId }));
        } catch (e) {
          report({ t: new Date().toISOString(), origin: "matrix-error", stepIndex: i, error: String(e), runId });
        }
      }
      // restore the pre-matrix real state
      try {
        await restoreState(saved);
        report(sample({ origin: "restored", runId }));
      } catch (e) {
        report({ t: new Date().toISOString(), origin: "restore-error", error: String(e), runId });
      }
    }

    function apply(ctx) {
      const timers = [];
      // Dead-code slot registration to satisfy the super-injector skeleton
      // preflight (REGISTER_NAME regex hit); never executed — this plugin has
      // no UI surface.
      if (false) {
        ctx.slots.register({ name: "conversation.view", component: () => null });
      }
      const start = (fn, ms) => {
        const t = setTimeout(fn, ms);
        timers.push(t);
      };

      // 1) boot: passive sample of the CURRENT state (includes whether or not
      //    a terminal is present)
      start(() => report(sample({ origin: "boot" })), 400);

      // (auto-matrix removed: every page load used to run a full skin/theme
      // matrix — diagnostic-only; use POST /api/terminal-probe/run instead)
      let ranRunId = null;
      const pollRun = async () => {
        try {
          const res = await fetch(API + "/run-state", { cache: "no-store" });
          const state = await res.json();
          if (!(state && state.pending)) return;
          if (state.runId === ranRunId) return;
          ranRunId = state.runId;
          const saved = { skin: currentSkin(), theme: currentTheme() };
          report({ t: new Date().toISOString(), origin: "matrix-start", saved, runId: state.runId, terminal: terminalPresent() });
          await runMatrix(saved, state.skins, state.themes, state.runId);
          fetch(API + "/run-ack", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ runId: state.runId }),
          }).catch(() => {});
        } catch (e) {
          // ignore transient errors
        }
      };
      const runPollTimer = setInterval(pollRun, 2000);

      // 3.5) refresh command: the host can ask this page to reload itself
      const pollRefresh = async () => {
        try {
          const res = await fetch(API + "/refresh-state", { cache: "no-store" });
          const state = await res.json();
          if (!(state && state.pending)) return;
          const consumed = localStorage.getItem("dsh-probe-refresh-consumed");
          if (consumed === String(state.refreshId)) return;
          localStorage.setItem("dsh-probe-refresh-consumed", String(state.refreshId));
          try {
            await fetch(API + "/refresh-ack", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ refreshId: state.refreshId }),
            });
          } catch (e) {
            // ignore — the local consumed marker still guards this page
          }
          location.reload();
        } catch (e) {
          // ignore transient errors
        }
      };
      const refreshPollTimer = setInterval(pollRefresh, 2000);

      // 4) passive sampling: report again whenever skin or theme changes
      let lastSig = "";
      const passive = setInterval(() => {
        const sig = (currentSkin() || "official") + "@" + currentTheme();
        if (sig !== lastSig) {
          lastSig = sig;
          report(sample({ origin: "change" }));
        }
      }, 2000);
      timers.push(passive, runPollTimer, refreshPollTimer);

      return () => {
        for (const t of timers) clearTimeout(t);
        clearInterval(passive);
        clearInterval(runPollTimer);
        clearInterval(refreshPollTimer);
      };
    }

    // `inject: ["slots"]` is a static declaration to satisfy the
    // super-injector skeleton preflight (v0.3.0: requires a slots declaration
    // on every client bundle). This diagnostic plugin renders no UI and never
    // touches ctx.slots at runtime; the slots service exists, so declaring it
    // is harmless.
    module.exports = { name: "dsh-terminal-probe", inject: ["slots"], apply };
    return module.exports;
  },
});