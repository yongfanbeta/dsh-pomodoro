// dsh-pomodoro client bundle (ModuleLoader format)
//
// Browser half of the pomodoro plugin. It owns the clock — the only place a
// user is actually looking — while the host half owns durability. Everything
// therefore talks to `/api/dsh-pomodoro/*` on the host; no bundled runtime
// dependency is required beyond React, which the module loader seeds.
//
// Three registrations:
//   1. `sidebar.panellist` — the monochrome tomato icon that selects the panel.
//   2. `main` (key `pomodoro`) — the standalone statistics and timer panel.
//   3. `conversation.input.dock` — a null renderer that records the Session the
//      user is currently looking at, so "关联当前任务" has something to resolve.
//   4. `conversation.composer.dock` — the ambient countdown row under the
//      composer, placed before the shipped session statistics.

window.__ModuleLoader__.load({
  id: 'dsh-pomodoro',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    //#region constants

    var API = '/api/dsh-pomodoro'
    var PANEL_KEY = 'pomodoro'
    var ACTIVE_RUN_STORAGE = 'dsh-pomodoro/active-run/v1'
    var MSS = { focus: '专注', 'short-break': '短休息', 'long-break': '长休息' }
    var PHASE_ORDER = ['focus', 'short-break', 'long-break']
    var TICK_MS = 250
    /** Monday-first weekday initials for the per-day chart. */
    var WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

    /**
     * Preset interruption reasons, mirroring `INTERRUPT_REASONS` in the core
     * schema. Duplicated rather than imported because the client half is a
     * prebuilt plain-script bundle that may not import host modules; the core
     * test asserts the two lists stay identical.
     */
    var REASONS = ['被叫走', '开会', '临时任务', '接电话／回消息', '分心', '到点吃饭／休息', '其他']

    /**
     * Fallback break-activity list, used only if the stored one is missing
     * (defensive; normalizeSettings always guarantees a non-empty list).
     */
    var DEFAULT_BREAK_ACTIVITIES = ['深蹲十个', '喝一杯水', '站起来拉伸', '闭眼休息 30 秒', '远眺放松眼睛']

    //#endregion

    //#region styles

    var css = [
      '.dshp-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;overflow:hidden}',
      '.dshp-head{flex:none;display:flex;align-items:center;gap:10px;padding:14px 18px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dshp-title{font-size:15px;font-weight:600;margin:0}',
      '.dshp-sub{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dshp-spacer{flex:1}',
      '.dshp-tabs{flex:none;display:flex;gap:2px;padding:8px 14px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dshp-tab{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;padding:6px 12px;border-radius:8px 8px 0 0;border-bottom:2px solid transparent}',
      '.dshp-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshp-tab.on{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}',
      '.dshp-body{flex:1;min-height:0;overflow:auto;padding:16px 18px 24px}',
      '.dshp-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:14px 16px;margin-bottom:12px}',
      '.dshp-cardTitle{font-size:13px;font-weight:600;margin:0 0 10px}',
      '.dshp-clockWrap{display:flex;flex-direction:column;align-items:center;gap:14px;padding:8px 0 4px}',
      // Circular dial: the ring is ALWAYS a complete circle. The track (the
      // un-elapsed part) is a visible neutral, so an idle or paused dial still
      // reads as a ring rather than vanishing into the card background.
      '.dshp-dial{position:relative;width:200px;height:200px;flex:none}',
      '.dshp-dial svg{display:block;width:100%;height:100%}',
      '.dshp-dialTrack{stroke:var(--dsw-static-neutral-bluish-100)}',
      'body[data-ds-dark-theme] .dshp-dialTrack{stroke:var(--dsw-static-neutral-bluish-800)}',
      '.dshp-dialRing{stroke:var(--dsw-alias-brand-primary);transition:stroke-dashoffset .25s linear}',
      '.dshp-dialRing.brk{stroke:var(--dsw-alias-state-success-primary)}',
      // Paused keeps the ring fully visible but recolours it: dimming it to
      // near-invisible is exactly the "nothing there" problem.
      '.dshp-dialRing.paused{stroke:var(--dsw-alias-state-warn-primary)}',
      '.dshp-dialCenter{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;pointer-events:none}',
      '.dshp-dialControl{pointer-events:auto;display:flex;align-items:center;justify-content:center;margin-top:8px}',
      '.dshp-dialTime{font-variant-numeric:tabular-nums;font-size:38px;line-height:1;font-weight:600;letter-spacing:.5px}',
      '.dshp-dialSub{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      // Compact ring used on the completion card and the status-bar popover.
      '.dshp-miniDial{position:relative;width:56px;height:56px;flex:none}',
      '.dshp-miniDial .dshp-dialTime{font-size:15px}',
      '.dshp-phase{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 12px;font-size:12px;border:1px solid var(--dsw-alias-border-l2)}',
      '.dshp-phase.focus{color:var(--dsw-alias-brand-primary);border-color:currentColor}',
      '.dshp-phase.short-break,.dshp-phase.long-break{color:var(--dsw-alias-state-success-primary);border-color:currentColor}',
      '.dshp-proj{font-size:14px;font-weight:500;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshp-projSrc{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.dshp-btns{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:4px}',
      '.dshp-btn{appearance:none;font:inherit;font-size:13px;cursor:pointer;border-radius:9px;padding:7px 16px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);transition:background-color .13s,border-color .13s}',
      '.dshp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshp-btn:disabled{opacity:.5;cursor:default}',
      '.dshp-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}',
      '.dshp-btn.primary:hover:not(:disabled){filter:brightness(1.08)}',
      '.dshp-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.dshp-btn.sm{padding:4px 10px;font-size:12px;border-radius:7px}',
      '.dshp-bar{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;width:100%;max-width:420px}',
      '.dshp-barFill{height:100%;background:var(--dsw-alias-brand-primary);transition:width .25s linear}',
      '.dshp-barFill.brk{background:var(--dsw-alias-state-success-primary)}',
      // Interruption rows use the SAME accent as the reason table and the
      // card, so "中断" reads as one colour everywhere.
      '.dshp-pill.interrupted{color:var(--dsw-alias-state-warn-primary)}',
      '.dshp-reasonTag{display:inline-flex;align-items:center;gap:4px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-state-warn-primary)}',
      // Non-interruption rows keep the column occupied but quiet, so the eye
      // can scan straight down the 中断原因 column.
      '.dshp-reasonTag.dshp-reasonEmpty{color:var(--dsw-alias-label-tertiary);opacity:.6}',
      '.dshp-recHead{color:var(--dsw-alias-label-secondary);font-size:11px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
      '.dshp-field{display:flex;flex-direction:column;gap:5px;margin-bottom:10px}',
      '.dshp-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dshp-input,.dshp-select{font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 9px;width:100%;box-sizing:border-box}',
      '.dshp-input:focus,.dshp-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
      '.dshp-select{color-scheme:light dark}',
      '.dshp-select option{background-color:#fff;color:#1f2328}',
      '@media (prefers-color-scheme:dark){.dshp-select option{background-color:#1e1f24;color:#e8e8ea}}',
      '.dshp-row{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}',
      '.dshp-row>.dshp-field{flex:1;min-width:120px;margin-bottom:0}',
      '.dshp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}',
      '.dshp-metric{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);border-radius:10px;padding:10px 12px}',
      '.dshp-metricK{font-size:11px;color:var(--dsw-alias-label-secondary);margin-bottom:4px}',
      '.dshp-metricV{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.2}',
      '.dshp-metricS{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:3px}',
      '.dshp-chart{display:flex;align-items:flex-end;gap:4px;height:180px;padding-top:6px}',
      // A column is bar-on-top, label-at-bottom, anchored to the chart floor.
      // justify-content:space-between would let the bar float mid-column on
      // tall rows, which is what made the axis numbers look misplaced.
      '.dshp-col{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0;cursor:default;justify-content:flex-end;height:100%}',
      '.dshp-colBar{width:100%;border-radius:4px 4px 2px 2px;background:var(--dsw-alias-brand-primary);min-height:2px;opacity:.85;flex:none}',
      '.dshp-colBar.zero{background:var(--dsw-alias-border-l2)}',
      // Pomodoro stack: a day/hour "bar" drawn as stacked 🍅 so the count IS
      // the picture. Bottom-anchored, growing upward like the old bar.
      '.dshp-tomatoStack{display:flex;flex-direction:column-reverse;align-items:center;gap:0;flex:none}',
      '.dshp-tomatoStack .dshp-tomatoStackItem{display:block}',
      '.dshp-tomatoStackMore{font-size:10px;line-height:1;color:var(--dsw-alias-label-secondary);margin-bottom:1px}',
      '.dshp-tomatoStackEmpty{width:100%;height:2px;border-radius:1px;background:var(--dsw-alias-border-l2);flex:none}',
      '.dshp-colK{font-size:9px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;flex:none;height:12px;line-height:12px;display:flex;align-items:center}',
      '.dshp-table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}',
      '.dshp-table th,.dshp-table td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dshp-table th{color:var(--dsw-alias-label-secondary);font-weight:500;font-size:11px}',
      '.dshp-table td.num,.dshp-table th.num{text-align:right}',
      '.dshp-table tbody tr:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshp-empty{color:var(--dsw-alias-label-secondary);font-size:12px;padding:14px 0;text-align:center}',
      '.dshp-note{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.6}',
      '.dshp-chips{display:flex;gap:6px;flex-wrap:wrap}',
      '.dshp-chip{appearance:none;font:inherit;font-size:12px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:999px;padding:3px 10px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshp-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshp-chip.on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}',
      '.dshp-check{display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:8px;cursor:pointer}',
      '.dshp-check input{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary)}',
      '.dshp-msg{font-size:12px;border-radius:8px;padding:7px 10px;margin-bottom:10px}',
      '.dshp-msg.err{color:var(--dsw-alias-state-error-primary);background:rgba(220,80,80,.12)}',
      '.dshp-msg.ok{color:var(--dsw-alias-state-success-primary);background:rgba(80,200,120,.12)}',
      '.dshp-recRow{display:flex;align-items:center;gap:8px;padding:7px 2px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}',
      // Interrupted rows get the same accent as the reason table, so the whole
      // "中断" story reads in one colour across the plugin.
      '.dshp-recRowInterrupted{background:var(--dsw-static-green-500-a08)}',
      // Fixed column shares so every row and the header line up exactly.
      '.dshp-recTime{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshp-recTime.dshp-recPhase{flex:0 0 60px}',
      '.dshp-recTime.dshp-recDur{flex:0 0 52px;text-align:right}',
      '.dshp-recAction{flex:0 0 52px;text-align:center}',
      '.dshp-recStateHead{color:var(--dsw-alias-label-secondary);border-color:transparent}',
      // 项目 is the only elastic column, so the row always fills the card width.
      '.dshp-recProj{flex:1 1 auto;min-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      // 中断原因 column is the widest fixed box: reasons are the point of it.
      '.dshp-reasonTag{display:inline-flex;align-items:center;flex:0 0 150px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-state-warn-primary)}',
      '.dshp-pill{flex:0 0 72px;font-size:11px;border-radius:999px;padding:2px 8px;border:1px solid currentColor;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshp-pill.completed{color:var(--dsw-alias-state-success-primary)}',
      '.dshp-pill.aborted{color:var(--dsw-alias-state-warn-primary)}',
      '.dshp-pill.skipped{color:var(--dsw-alias-state-idle-primary)}',
      '.dshp-split{display:flex;gap:12px;flex-wrap:wrap}',
      '.dshp-split>*{flex:1;min-width:260px}',
      '.dshp-glyph{display:inline-flex;align-items:center;justify-content:center}',
      // --- tomato mark: thin line art, matching the shipped outline icons ---
      '.dshp-tomato{display:block;flex:none}',
      // --- 365-day contribution heatmap (GitHub-style green) ---
      // The grid fills the card edge to edge. Columns read MONDAY at the top.
      //
      // Alignment strategy: the MONTH band is a sibling of the weekday column,
      // so its height is shared rather than hardcoded. The weekday labels then
      // flex:1 inside a column that is exactly as tall as the grid — which is
      // what makes 一 and 日 sit on the first and last row however much the
      // squares stretch.
      // Alignment rule: the label column and the grid live in `.dshp-heatCols`
      // and NOTHING else does. The legend sits outside that row, so the labels
      // stretch to exactly the grid's height — that is what puts 一 on the first
      // square and 日 on the last.
      '.dshp-heatWrap{display:flex;flex-direction:column}',
      '.dshp-heatMonths{flex:none;display:flex;gap:3px;height:14px;margin-bottom:4px;font-size:10px;color:var(--dsw-alias-label-secondary);margin-left:22px}',
      '.dshp-heatMonthSlot{flex:1;min-width:0;display:flex;overflow:visible}',
      '.dshp-heatMonth{white-space:nowrap;overflow:visible}',
      '.dshp-heatCols{display:flex;gap:6px;align-items:stretch;flex:none}',
      '.dshp-heatDows{display:flex;flex-direction:column;gap:3px;flex:none;width:16px}',
      '.dshp-heatDow{flex:1 1 0;min-height:0;display:flex;align-items:center;justify-content:flex-end;font-size:9px;color:var(--dsw-alias-label-secondary)}',
      '.dshp-heat{display:flex;gap:3px;flex:1;min-width:0}',
      // Sparse weekday labels: showing all seven would need 7× the row height,
      // so we label the odd rows — matching GitHub's "Mon/Wed/Fri" rhythm.
      '.dshp-heatDows .dshp-heatDow:nth-child(even){visibility:hidden}',
      '.dshp-heatCol{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}',
      // Level 0 is an empty cell; levels 1-4 layer the theme green with rising
      // opacity. Compositing against the card is what lets ONE definition read
      // correctly in both themes: pale mint on white, deep forest on near-black.
      // Cells are square by aspect-ratio and stretch to fill the card width, so
      // the grid is exactly as wide as the cards above and below it.
      '.dshp-heatCell{width:100%;aspect-ratio:1/1;border-radius:2px;background:var(--dsw-static-neutral-bluish-100)}',
      'body[data-ds-dark-theme] .dshp-heatCell{background:var(--dsw-static-neutral-bluish-800)}',
      '.dshp-heatCell.l1,.dshp-heatCell.l2,.dshp-heatCell.l3,.dshp-heatCell.l4{background:var(--dsw-static-green-500)}',
      '.dshp-heatCell.l1{opacity:.25}',
      '.dshp-heatCell.l2{opacity:.45}',
      '.dshp-heatCell.l3{opacity:.7}',
      '.dshp-heatCell.l4{opacity:1}',
      // A future day is "not yet", not "zero": outline it instead of filling.
      '.dshp-heatCell.future{background:transparent;box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2)}',
      '.dshp-heatLegend{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--dsw-alias-label-secondary);margin-top:8px;flex-wrap:wrap}',
      // Legend swatches are FIXED size: they must not inherit the stretching
      // grid cell sizing above, or 少/多 would render as huge squares.
      '.dshp-heatLegend .dshp-heatCell{width:10px;height:10px;aspect-ratio:auto;flex:none}',
      // --- ambient status-bar timer: one pill, details on click ---
      '.dshp-dock{position:relative;display:inline-flex;align-items:center}',
      '.dshp-dockPill{appearance:none;display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12px;background:transparent;border:0;cursor:pointer;color:var(--dsw-alias-label-secondary);padding:2px 7px;border-radius:7px;line-height:1.5}',
      '.dshp-dockPill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshp-dockPill.run{color:var(--dsw-alias-label-primary)}',
      '.dshp-dockTime{font-variant-numeric:tabular-nums;font-weight:600;font-size:13px;min-width:42px;text-align:left}',
      // The gentle pulse is the "live" cue: a static digital readout on a long
      // focus run otherwise looks frozen.
      '.dshp-dockPill.run .dshp-dockTime{animation:dshp-tick 1s ease-in-out infinite}',
      '@keyframes dshp-tick{0%,100%{opacity:1}50%{opacity:.7}}',
      '@media (prefers-reduced-motion:reduce){.dshp-dockPill.run .dshp-dockTime{animation:none}}',
      '.dshp-dockCard{position:absolute;bottom:calc(100% + 8px);left:0;z-index:30;min-width:238px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.16);padding:10px 12px;font-size:12px;color:var(--dsw-alias-label-primary);text-align:left}',
      '.dshp-dockRow{display:flex;justify-content:space-between;gap:14px;padding:2px 0}',
      '.dshp-dockK{color:var(--dsw-alias-label-secondary);flex:none}',
      '.dshp-dockV{font-variant-numeric:tabular-nums;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshp-dockActions{display:flex;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dshp-dockBtn{appearance:none;font:inherit;font-size:11px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;padding:2px 9px;line-height:1.6}',
      '.dshp-dockBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshp-dockBtn.primary{color:var(--dsw-static-green-500);border-color:currentColor}',
      '.dshp-dockSep{opacity:.4}',
      // --- interruption reason prompt ---
      '.dshp-prompt{position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center;padding:24px}',
      '.dshp-promptCard{width:100%;max-width:420px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;box-shadow:0 18px 48px rgba(0,0,0,.28);padding:18px 20px;color:var(--dsw-alias-label-primary)}',
      '.dshp-promptTitle{font-size:15px;font-weight:600;margin:0 0 4px}',
      '.dshp-promptSub{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:14px}',
      '.dshp-reasons{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:12px}',
      '.dshp-reason{appearance:none;font:inherit;font-size:12px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:999px;padding:4px 12px}',
      '.dshp-reason:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshp-reason.on{background:var(--dsw-static-green-500);border-color:var(--dsw-static-green-500);color:#fff}',
      '.dshp-reasonCustom{display:flex;gap:8px;margin-bottom:14px}',
      '.dshp-reasonCustom .dshp-input{flex:1}',
      '.dshp-promptActions{display:flex;justify-content:flex-end;gap:8px}',
      // --- completion card (in-app overlay, dismissible only by the user) ---
      '.dshp-cards{position:fixed;right:20px;bottom:20px;z-index:70;display:flex;flex-direction:column;gap:10px;align-items:flex-end;pointer-events:none}',
      '.dshp-card2{pointer-events:auto;width:320px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-static-green-500);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.22);padding:14px 16px;color:var(--dsw-alias-label-primary)}',
      '.dshp-card2.break{border-left-color:var(--dsw-alias-state-warn-primary)}',
      '.dshp-cardHead{display:flex;align-items:baseline;gap:8px;margin-bottom:6px}',
      '.dshp-cardTitle{font-size:14px;font-weight:600;margin:0;flex:1}',
      '.dshp-cardClose{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:16px;line-height:1;padding:0 2px}',
      '.dshp-cardClose:hover{color:var(--dsw-alias-label-primary)}',
      '.dshp-cardBody{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:10px;line-height:1.6}',
      '.dshp-cardNext{display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:10px}',
      '.dshp-cardNextTime{font-variant-numeric:tabular-nums;font-weight:600;font-size:15px;color:var(--dsw-alias-label-primary)}',
      '.dshp-cardDot{width:7px;height:7px;border-radius:50%;background:var(--dsw-static-green-500);flex:none}',
      '.dshp-cardDot.brk{background:var(--dsw-alias-state-warn-primary)}',
      '.dshp-cardActions{display:flex;gap:8px}',
      // Break-activity suggestion inside the completion card.
      '.dshp-cardActivity{display:flex;gap:6px;align-items:baseline;font-size:13px;margin-bottom:10px;padding:7px 10px;border-radius:8px;background:var(--dsw-static-green-500-a08);color:var(--dsw-alias-label-primary)}',
      '.dshp-cardActivityK{color:var(--dsw-alias-label-secondary);flex:none}',
      '.dshp-cardActivityV{font-weight:600}',
      // Floating timer: frame-wide, bottom-right by default, draggable. Two
      // forms share one uniform surface — single background, no gradient, no
      // split header — differing only in shape: strict square vs. small bar.
      '.dshp-float{position:fixed;right:20px;bottom:20px;z-index:60;width:220px;height:220px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:18px;box-shadow:0 14px 34px rgba(0,0,0,.22);color:var(--dsw-alias-label-primary);overflow:hidden;font-size:12px}',
      '@supports (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)){',
      '.dshp-float{background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 76%,transparent);backdrop-filter:blur(18px) saturate(150%);-webkit-backdrop-filter:blur(18px) saturate(150%)}',
      '}',
      'body[data-ds-dark-theme] .dshp-float{box-shadow:0 14px 34px rgba(0,0,0,.55)}',
      // Window controls live INSIDE the top-right corner of the square.
      // Glyphs are CSS-drawn so their lengths can be tuned independently,
      // and fixed button boxes keep both optically aligned on one row.
      '.dshp-floatCorner{position:absolute;top:6px;right:6px;display:flex;align-items:center;gap:2px;z-index:2}',
      '.dshp-floatMiniBtn,.dshp-floatClose{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;width:20px;height:20px;display:flex;align-items:center;justify-content:center;padding:0;border-radius:6px}',
      '.dshp-floatMiniBtn:hover,.dshp-floatClose:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3)}',
      // Minus: deliberately short.
      '.dshp-floatIcoMinus{position:relative;width:8px;height:1.5px;background:currentColor;border-radius:1px}',
      // Expand: a clean square frame (the classic "restore" glyph).
      '.dshp-floatIcoExpand{position:relative;width:9px;height:9px;border:1.5px solid currentColor;border-radius:2px}',
      // Cross: a touch longer than the minus.
      '.dshp-floatIcoX{position:relative;width:10px;height:10px}',
      '.dshp-floatIcoX::before,.dshp-floatIcoX::after{content:"";position:absolute;left:0;top:4.25px;width:10px;height:1.5px;background:currentColor;border-radius:1px}',
      '.dshp-floatIcoX::before{transform:rotate(45deg)}',
      '.dshp-floatIcoX::after{transform:rotate(-45deg)}',
      // The square body: dial + the current project, centred, nothing else.
      '.dshp-floatBody{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:14px;pointer-events:none}',
      '.dshp-floatBody .dshp-dial,.dshp-floatBody .dshp-floatProj,.dshp-floatBody .dshp-floatProjEdit{pointer-events:auto}',
      '.dshp-floatBody .dshp-dial{width:150px;height:150px}',
      '.dshp-floatProj{display:inline-flex;align-items:center;gap:6px;max-width:100%;font-size:13px;font-weight:500;cursor:pointer;padding:2px 6px;border-radius:6px}',
      '.dshp-floatProj:hover{background:var(--dsw-alias-bg-layer-3)}',
      '.dshp-floatProj .edit{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dshp-floatProj .edit.dim{opacity:.5}',
      '.dshp-floatProjEdit{display:flex;gap:6px;align-items:center;width:100%}',
      '.dshp-floatProjEdit .dshp-input{flex:1;min-width:0;height:28px;font-size:12px}',
      // Collapsed bar: FIXED box (border-box) so no host-page global
      // stylesheet can stretch it; digits sit near the LEFT edge (no leading
      // void); the digits are dead-centre in the bar (corner buttons are
      // absolutely positioned and never shift the text).
      '.dshp-float.mini{display:flex;align-items:center;justify-content:center;position:relative;width:104px;height:44px;padding:0;box-sizing:border-box;overflow:visible;border-radius:14px;box-shadow:0 8px 20px rgba(0,0,0,.22);cursor:move}',
      '@supports (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)){',
      '.dshp-float.mini{background:color-mix(in srgb,var(--dsw-alias-bg-overlay) 76%,transparent);backdrop-filter:blur(18px) saturate(150%);-webkit-backdrop-filter:blur(18px) saturate(150%)}',
      '}',
      'body[data-ds-dark-theme] .dshp-float.mini{box-shadow:0 8px 20px rgba(0,0,0,.55)}',
      // No separate white chip: the button melts into the shared surface.
      '.dshp-floatPlay{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;width:24px;height:24px;border-radius:8px;font-size:11px;line-height:1;display:flex;align-items:center;justify-content:center;flex:none}',
      '.dshp-floatPlay:hover{background:var(--dsw-alias-bg-layer-3)}',
      // In the expanded square the button sits inside the ring under the time.
      '.dshp-floatBody .dshp-floatPlay{width:30px;height:24px;border-radius:999px;font-size:12px}',
      // Collapsed bar: digits alone, dead-centre; corner buttons stay small
      // and clear of the text (fixed 34px side padding on BOTH sides keeps
      // the digits exactly centred; buttons overlay the right padding zone).
      '.dshp-floatMiniTime{font-variant-numeric:tabular-nums;font-size:26px;font-weight:600;line-height:44px;letter-spacing:.5px;color:var(--dsw-alias-label-primary);white-space:nowrap;flex:none;transform:translateY(-1.5px)}',
      '.dshp-float.mini.brk .dshp-floatMiniTime{color:var(--dsw-alias-state-success-primary)}',
      // Mini corner buttons: extra faint and small, pinned top-right so they
      // read as plumbing rather than UI.
      '.dshp-floatMiniBar{position:absolute;top:2px;right:2px;display:flex;align-items:center;gap:0;padding:0 1px;z-index:2;opacity:.4}',
      '.dshp-floatMiniBar:hover{opacity:1}',
      '.dshp-float.mini .dshp-floatMiniBtn,.dshp-float.mini .dshp-floatClose{width:11px;height:11px;color:var(--dsw-alias-label-secondary)}',
      '.dshp-float.mini .dshp-floatIcoExpand{width:6px;height:6px;border-width:1px}',
      '.dshp-float.mini .dshp-floatIcoX{width:6px;height:6px}',
      '.dshp-float.mini .dshp-floatIcoX::before,.dshp-float.mini .dshp-floatIcoX::after{width:6px;top:2.5px;height:1px}',
      // Break-activity editor (Settings).
      '.dshp-actList{display:flex;flex-direction:column;gap:8px;margin-bottom:4px}',
      '.dshp-actRow{display:flex;gap:8px;align-items:center}',
      '.dshp-actRow .dshp-input{flex:1;min-width:0}',
      '.dshp-actRow .dshp-btn{flex:none}',

    ].join('')

    function insertStyles() {
      var tagId = 'dsh-pomodoro/panel.css'
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return
      var tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-pomodoro'
      tag.dataset.pluginCss = tagId
      tag.textContent = css
      document.head.appendChild(tag)
    }

    //#endregion

    //#region tiny utilities

    /** Minimal immutable snapshot store: `set` replaces the object identity. */
    function createStore(initial) {
      var state = initial
      var listeners = new Set()
      return {
        get: function () {
          return state
        },
        set: function (nextOrFn) {
          var next = typeof nextOrFn === 'function' ? nextOrFn(state) : nextOrFn
          if (next === state) return
          state = next
          listeners.forEach(function (listener) {
            try {
              listener()
            } catch (error) {
              console.error('[dsh-pomodoro] listener failed:', error)
            }
          })
        },
        subscribe: function (listener) {
          listeners.add(listener)
          return function () {
            listeners.delete(listener)
          }
        },
      }
    }

    /** Subscribe a component to a store, with a fallback for pre-18 React. */
    function useStore(store) {
      var useSync = React.useSyncExternalStore
      if (typeof useSync === 'function') {
        return useSync(store.subscribe, store.get, store.get)
      }
      var pair = React.useState(store.get)
      React.useEffect(
        function () {
          return store.subscribe(function () {
            pair[1](store.get())
          })
        },
        [store],
      )
      return pair[0]
    }

    function pad2(n) {
      return String(n).padStart(2, '0')
    }

    /** Local-calendar day/hour/month boundaries, reused by the scope-aware charts. */
    function startOfDayMs(time) {
      var d = new Date(time)
      d.setHours(0, 0, 0, 0)
      return d.getTime()
    }
    function startOfWeekMs(time) {
      var d = new Date(time)
      d.setHours(0, 0, 0, 0)
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
      return d.getTime()
    }
    function startOfMonthMs(time) {
      var d = new Date(time)
      return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
    }

    /** `mm:ss` for a remaining/elapsed duration. */
    function clockText(ms) {
      var total = Math.max(0, Math.round(ms / 1000))
      var minutes = Math.floor(total / 60)
      var seconds = total % 60
      return pad2(minutes) + ':' + pad2(seconds)
    }

    /** `H小时M分` style duration summary. */
    function humanMinutes(minutes) {
      var value = Number(minutes) || 0
      if (value < 60) return Math.round(value * 10) / 10 + ' 分钟'
      var hours = Math.floor(value / 60)
      var rest = Math.round((value - hours * 60) * 10) / 10
      return hours + ' 小时' + (rest > 0 ? ' ' + rest + ' 分' : '')
    }

    /** Local `MM-DD HH:mm` for a record row. */
    function stampText(timeMs) {
      if (!Number.isFinite(timeMs) || timeMs <= 0) return '—'
      var d = new Date(timeMs)
      return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
    }

    /** `YYYY-MM-DD` local day key, matching the host's aggregation. */
    function localDayKey(timeMs) {
      var d = new Date(timeMs)
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    }

    /** Absolute URL for the CSV download of a date window. */
    function exportUrl(from, to) {
      var query = []
      if (from) query.push('from=' + encodeURIComponent(from))
      if (to) query.push('to=' + encodeURIComponent(to))
      return API + '/export' + (query.length > 0 ? '?' + query.join('&') : '')
    }

    //#endregion

    //#region host bridge

    /**
     * Set once the plugin fiber is disposed.
     *
     * Fire-and-forget calls (`void refreshSuggestion()`) can still be in flight
     * when a hot reload tears this bundle down; without this guard the OLD
     * instance keeps talking to the host and can write stale state over the new
     * one. Every bridge call checks it, and the disposer flips it.
     */
    var disposed = false

    /** POST one action; resolves `{ok, value}` and never throws for HTTP errors. */
    async function call(action, body) {
      if (disposed) return { ok: false, error: { code: 'disposed', message: 'plugin unloaded' } }
      var response
      try {
        response = await fetch(API + '/' + action, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        })
      } catch (error) {
        // A transport failure is a normal outcome (host restarting, HMR
        // reload), never an unhandled rejection.
        return { ok: false, error: { code: 'unreachable', message: String((error && error.message) || error) } }
      }
      var payload = null
      try {
        payload = await response.json()
      } catch (error) {
        return { ok: false, error: { code: 'bad-response', message: 'HTTP ' + response.status } }
      }
      return payload
    }

    //#endregion

    //#region timer engine

    var api = {
      /** Load settings, records, statistics and recent projects. */
      async state() {
        return await call('state', {})
      },
      /** Ask the host what "current task" means for this Session. */
      async context(sessionId) {
        return await call('context', { sessionId: sessionId })
      },
      /** Persist one finished (or aborted) run. */
      async record(record) {
        return await call('record', { record: record })
      },
      /** Patch settings; the host normalizes and clamps. */
      async settings(settings) {
        return await call('settings', { settings: settings })
      },
      async remove(id) {
        return await call('delete', { id: id })
      },
      async clear(scope, from, to) {
        return await call('clear', { scope: scope, from: from, to: to })
      },
    }

    /**
     * The one timer store, module-scoped: the clock must keep running while the
     * panel is closed, so it cannot live inside a component.
     */
    var store = createStore({
      settings: {
        focusMinutes: 25,
        shortBreakMinutes: 5,
        longBreakMinutes: 15,
        longBreakEvery: 4,
        autoStartBreak: true,
        autoStartNext: false,
        recordAborted: true,
        recordBreaks: false,
        soundEnabled: false,
        notifyEnabled: false,
        cardEnabled: true,
        defaultProject: '未命名项目',
        showBadgeInSidebar: true,
        showTimerInStatusBar: true,
      },
      records: [],
      stats: null,
      recentProjects: [],
      storePath: '',
      loading: true,
      error: '',
      notice: '',
      // Live run
      phase: 'focus',
      status: 'idle',
      plannedMs: 25 * 60_000,
      remainingMs: 25 * 60_000,
      deadline: 0,
      runStartedAt: 0,
      focusedMs: 0,
      cycleFocusCount: 0,
      /**
       * Wall-clock ms accumulated across the segments already committed to this
       * pomodoro. Resume adds a fresh segment, so a paused-and-resumed run still
       * credits exactly the time actually spent (never the paused gap).
       */
      accumulatedMs: 0,
      /** When the current live segment began; 0 while paused/idle. */
      segmentStartedAt: 0,
      /** Interruptions recorded inside the CURRENT pomodoro, which may resume. */
      interruptions: 0,
      /** Phase-end announcement shown as a dismissible card, or null. */
      card: null,
      /** Open interruption-reason prompt, or null. */
      reasonPrompt: null,
      /** Break activity picked for the current break (null while not on a break). */
      currentBreakActivity: null,
      project: { name: '', source: 'default', sessionId: '' },
      // Context resolution
      activeSessionId: '',
      suggestion: null,
    })

    /** Read the active run from localStorage so a reload cannot lose a pomodoro. */
    function loadActiveRun() {
      try {
        var raw = window.localStorage.getItem(ACTIVE_RUN_STORAGE)
        if (!raw) return null
        var parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return null
        return parsed
      } catch (error) {
        return null
      }
    }

    /** Persist (or drop) the active run. Idle runs are never stored. */
    function saveActiveRun(snapshot) {
      try {
        if (snapshot.status === 'idle' && snapshot.focusedMs === 0) {
          window.localStorage.removeItem(ACTIVE_RUN_STORAGE)
          return
        }
        window.localStorage.setItem(
          ACTIVE_RUN_STORAGE,
          JSON.stringify({
            phase: snapshot.phase,
            status: snapshot.status,
            plannedMs: snapshot.plannedMs,
            remainingMs: snapshot.remainingMs,
            deadline: snapshot.deadline,
            runStartedAt: snapshot.runStartedAt,
            focusedMs: snapshot.focusedMs,
            cycleFocusCount: snapshot.cycleFocusCount,
            project: snapshot.project,
          }),
        )
      } catch (error) {
        /* private mode / quota — the timer still works, it just cannot survive a reload */
      }
    }

    /** Minutes for one phase under the current settings. */
    function plannedMsOf(settings, phase) {
      var minutes =
        phase === 'focus' ? settings.focusMinutes : phase === 'short-break' ? settings.shortBreakMinutes : settings.longBreakMinutes
      return Math.max(1, Number(minutes) || 1) * 60_000
    }

    /** Short tone + optional system notification at a phase boundary. */
    function announce(card) {
      var settings = store.get().settings
      if (settings.soundEnabled) {
        try {
          var Ctor = window.AudioContext || window.webkitAudioContext
          if (typeof Ctor === 'function') {
            var ctxAudio = new Ctor()
            var osc = ctxAudio.createOscillator()
            var gain = ctxAudio.createGain()
            osc.type = 'sine'
            // Two notes so "focus done" and "break done" are distinguishable
            // without reading the card.
            osc.frequency.value = card.kind === 'focus-done' ? 880 : 620
            gain.gain.value = 0.06
            osc.connect(gain)
            gain.connect(ctxAudio.destination)
            osc.start()
            setTimeout(function () {
              try {
                osc.stop()
                ctxAudio.close()
              } catch (error) {
                /* already closed */
              }
            }, 520)
          }
        } catch (error) {
          /* audio is a nicety, never a failure */
        }
      }
      if (settings.notifyEnabled && typeof Notification === 'function') {
        try {
          if (Notification.permission === 'granted') {
            new Notification(card.title, { body: card.body })
          }
        } catch (error) {
          /* notifications are a nicety */
        }
      }
    }

    /** Pick one break activity at random from the (non-empty) settings list. */
    function pickBreakActivity(settings) {
      var list = Array.isArray(settings.breakActivities) && settings.breakActivities.length > 0
        ? settings.breakActivities
        : DEFAULT_BREAK_ACTIVITIES
      return list[Math.floor(Math.random() * list.length)]
    }

    /** Transition to a phase, keeping the clock and the accounting consistent. */
    function enterPhase(phase, options) {
      var state = store.get()
      var planned = plannedMsOf(state.settings, phase)
      var autoStart = options && options.autoStart === true
      var now = Date.now()
      // A break suggests a random activity; a focus phase clears it.
      var breakActivity = phase === 'focus' ? null : pickBreakActivity(state.settings)
      store.set(
        Object.assign({}, state, {
          phase: phase,
          status: autoStart ? 'running' : 'idle',
          plannedMs: planned,
          remainingMs: planned,
          deadline: autoStart ? now + planned : 0,
          runStartedAt: autoStart ? now : 0,
          focusedMs: 0,
          accumulatedMs: 0,
          segmentStartedAt: autoStart ? now : 0,
          // A new phase is a new pomodoro: last phase's interruptions are done.
          interruptions: 0,
          currentBreakActivity: breakActivity,
        }),
      )
      saveActiveRun(store.get())
    }

    /** Which phase follows a finished one, honoring the long-break cadence. */
    function nextPhaseAfter(phase, completedFocus) {
      var settings = store.get().settings
      if (phase !== 'focus') return 'focus'
      var every = Math.max(1, Number(settings.longBreakEvery) || 4)
      return completedFocus > 0 && completedFocus % every === 0 ? 'long-break' : 'short-break'
    }

    /**
     * Whether the next phase should begin on its own.
     *
     * A finished FOCUS run rolls into its break when `autoStartBreak` is on;
     * a finished BREAK waits for a click unless `autoStartNext` is on, because
     * silently starting a new 25-minute commitment is a bigger surprise.
     */
    function shouldAutoStart(finishedPhase) {
      var settings = store.get().settings
      return finishedPhase === 'focus' ? settings.autoStartBreak === true : settings.autoStartNext === true
    }

    /** Wall-clock ms spent in this pomodoro so far, excluding paused gaps. */
    function elapsedMsOf(state, now) {
      var live = state.status === 'running' && state.segmentStartedAt > 0 ? Math.max(0, now - state.segmentStartedAt) : 0
      return (Number(state.accumulatedMs) || 0) + live
    }

    /** Open the dismissible completion card for a finished phase. */
    function showCard(card) {
      if (store.get().settings.cardEnabled !== true) return
      store.set(Object.assign({}, store.get(), { card: card }))
    }

    /** Persist a finished run and refresh the local statistics mirror. */
    async function persistRun(record) {
      var result = await api.record(record)
      if (result && result.ok === true) {
        applyState(result.value)
      } else {
        store.set(Object.assign({}, store.get(), { error: '记录保存失败：' + describeError(result) }))
      }
      return result
    }

    /** Human text from a host error envelope. */
    function describeError(result) {
      if (result && result.error && typeof result.error.message === 'string') return result.error.message
      return '未知错误'
    }

    /** Merge a host state payload into the store. */
    function applyState(value) {
      if (value === null || typeof value !== 'object') return
      var state = store.get()
      var settings = value.settings || state.settings
      store.set(
        Object.assign({}, state, {
          settings: settings,
          records: Array.isArray(value.records) ? value.records : state.records,
          stats: value.stats === undefined ? state.stats : value.stats,
          recentProjects: Array.isArray(value.recentProjects) ? value.recentProjects : state.recentProjects,
          storePath: typeof value.storePath === 'string' ? value.storePath : state.storePath,
          // Re-derive the plan for an untimed phase so a settings change lands
          // on the dial immediately instead of after the next run.
          plannedMs: state.status === 'idle' ? plannedMsOf(settings, state.phase) : state.plannedMs,
          remainingMs: state.status === 'idle' ? plannedMsOf(settings, state.phase) : state.remainingMs,
          loading: false,
          error: '',
        }),
      )
    }

    /** Effective project name: explicit choice, else the configured default. */
    function effectiveProject(state) {
      var name = state.project && state.project.name ? state.project.name : ''
      if (name !== '') return name
      return state.settings.defaultProject
    }

    var SOURCE_LABELS = { session: '会话标题', workspace: '工作区', recent: '最近使用', manual: '手动输入', default: '默认' }

    /** Transfer the run into the record shape the host validates. */
    function buildRecord(state, status, now, overrides) {
      var extra = overrides || {}
      var startedAt = state.runStartedAt > 0 ? state.runStartedAt : now - state.focusedMs
      // A completed pomodoro credits its full plan; every other outcome credits
      // the time actually spent, which is what makes "focused today" honest.
      var focusedMs =
        status === 'completed' ? state.plannedMs : Math.max(0, extra.focusedMs !== undefined ? extra.focusedMs : state.focusedMs)
      return {
        project: effectiveProject(state),
        source: state.project && state.project.source ? state.project.source : 'default',
        sessionId: state.project && state.project.sessionId ? state.project.sessionId : '',
        phase: state.phase,
        status: status,
        startedAt: extra.startedAt !== undefined ? extra.startedAt : startedAt,
        endedAt: now,
        plannedMs: state.plannedMs,
        focusedMs: focusedMs,
        reason: typeof extra.reason === 'string' ? extra.reason : '',
      }
    }

    /**
     * The phase just finished. Records the outcome, announces it in a card, and
     * moves to the next phase.
     *
     * Order matters: the card is published BEFORE `enterPhase` so it survives
     * the state replacement, and `enterPhase` is what actually applies the
     * auto-start decision.
     */
    async function completeRun(now) {
      var state = store.get()
      var phase = state.phase
      var finishedProject = effectiveProject(state)
      var record = buildRecord(state, 'completed', now)
      var isFocus = phase === 'focus'
      var completedFocus = isFocus ? state.cycleFocusCount + 1 : state.cycleFocusCount
      var shouldRecord = isFocus || state.settings.recordBreaks === true

      var next = nextPhaseAfter(phase, completedFocus)
      var autoStart = shouldAutoStart(phase)
      var breakMinutes = Math.round(plannedMsOf(state.settings, next) / 60_000)
      var interruptionCount = Number(state.interruptions) || 0

      var card = isFocus
        ? {
            kind: 'focus-done',
            title: '专注完成 🍅',
            body:
              '已完成 1 个番茄 · ' + finishedProject + (interruptionCount > 0 ? '（期间中断 ' + interruptionCount + ' 次）' : ''),
            nextPhase: next,
            nextLabel: MSS[next] + ' ' + breakMinutes + ' 分钟',
            autoStarted: autoStart,
          }
        : {
            kind: 'break-done',
            title: '休息结束',
            body: '准备回到专注：' + finishedProject,
            nextPhase: next,
            nextLabel: MSS[next] + ' ' + Math.round(plannedMsOf(state.settings, next) / 60_000) + ' 分钟',
            autoStarted: autoStart,
          }

      store.set(
        Object.assign({}, store.get(), {
          cycleFocusCount: completedFocus,
          notice: '',
        }),
      )
      showCard(card)
      enterPhase(next, { autoStart: autoStart })
      announce(card)
      if (shouldRecord) await persistRun(record)
      return record
    }

    /** The single ticker: recomputes the remaining time from the deadline. */
    function startTicker() {
      return setInterval(
        function () {
          var state = store.get()
          if (state.status !== 'running') return
          var now = Date.now()
          var remaining = state.deadline - now
          if (remaining <= 0) {
            void completeRun(now)
            return
          }
          // Only publish when the displayed second moves. Sub-second ticks
          // change nothing a user can see, and re-rendering four times a
          // second would be pure waste; the deadline stays authoritative, so
          // a throttled tab still catches up exactly.
          if (Math.ceil(remaining / 1000) !== Math.ceil(state.remainingMs / 1000)) {
            store.set(
              Object.assign({}, state, {
                remainingMs: remaining,
                focusedMs: elapsedMsOf(state, now),
              }),
            )
            saveActiveRun(store.get())
          }
        },
        TICK_MS,
      )
    }

    /**
     * Start or resume the current run, opening a fresh timing segment.
     *
     * Continuity is tracked as SEGMENTS: `accumulatedMs` holds committed
     * wall-clock time and `segmentStartedAt` marks the live one. That is what
     * lets a paused-and-resumed pomodoro credit exactly the focused time while
     * never billing the paused gap.
     */
    function startRun() {
      var state = store.get()
      if (state.status === 'running') return
      var now = Date.now()
      var remaining = state.remainingMs > 0 ? state.remainingMs : state.plannedMs
      store.set(
        Object.assign({}, state, {
          status: 'running',
          remainingMs: remaining,
          deadline: now + remaining,
          runStartedAt: state.runStartedAt > 0 ? state.runStartedAt : now,
          segmentStartedAt: now,
          notice: '',
          reasonPrompt: null,
        }),
      )
      saveActiveRun(store.get())
    }

    /** Pause the current run, committing the live segment's time. */
    function pauseRun() {
      var state = store.get()
      if (state.status !== 'running') return
      var now = Date.now()
      var remaining = Math.max(0, state.deadline - now)
      var live = state.segmentStartedAt > 0 ? Math.max(0, now - state.segmentStartedAt) : 0
      store.set(
        Object.assign({}, state, {
          status: 'paused',
          remainingMs: remaining,
          deadline: 0,
          accumulatedMs: (Number(state.accumulatedMs) || 0) + live,
          segmentStartedAt: 0,
          focusedMs: state.plannedMs - remaining,
        }),
      )
      saveActiveRun(store.get())
    }

    /** Minimum focused time before an interruption is worth recording. */
    var INTERRUPT_FLOOR_MS = 30_000

    /**
     * Pause the pomodoro AND record an interruption with a reason.
     *
     * This is the "暂停并记录中断" action: the pomodoro is NOT abandoned, so
     * `继续` resumes the same dial and a later completion still counts as a
     * completed pomodoro. The interruption is stored as its own `interrupted`
     * event carrying the reason, which is what keeps the reason log complete
     * without double-counting the pomodoro in the statistics.
     *
     * @param reason - preset or free text; empty means "no reason given".
     */
    async function pauseWithReason(reason) {
      var state = store.get()
      if (state.status !== 'running' && state.status !== 'paused') return
      var now = Date.now()
      var elapsed = elapsedMsOf(state, now)
      var live = state.status === 'running' && state.segmentStartedAt > 0 ? Math.max(0, now - state.segmentStartedAt) : 0
      var remaining = state.status === 'running' ? Math.max(0, state.deadline - now) : state.remainingMs

      // Pause first so the dial is stopped regardless of what the record does.
      store.set(
        Object.assign({}, state, {
          status: 'paused',
          remainingMs: remaining,
          deadline: 0,
          accumulatedMs: (Number(state.accumulatedMs) || 0) + live,
          segmentStartedAt: 0,
          focusedMs: elapsed,
          reasonPrompt: null,
        }),
      )
      saveActiveRun(store.get())

      // A reasonless tap within the floor is treated as an accidental pause and
      // is not written: the reason log must not fill with noise.
      if (state.settings.recordAborted !== true) return
      if (state.phase !== 'focus' || elapsed < INTERRUPT_FLOOR_MS) return

      var event = buildRecord(store.get(), 'interrupted', now, {
        reason: reason,
        focusedMs: elapsed,
        // The event happened NOW; its own span is the segment it interrupted.
        startedAt: state.segmentStartedAt > 0 ? state.segmentStartedAt : now,
      })
      store.set(Object.assign({}, store.get(), { interruptions: (Number(store.get().interruptions) || 0) + 1 }))
      saveActiveRun(store.get())
      await persistRun(event)
    }

    /** Open the reason prompt for the pause-and-record action. */
    function openReasonPrompt() {
      var state = store.get()
      if (state.status !== 'running' && state.status !== 'paused') return
      store.set(Object.assign({}, store.get(), { reasonPrompt: { at: Date.now() } }))
    }

    /**
     * Dismiss the reason prompt without interrupting.
     *
     * Cancelling is a true no-op: the prompt was a confirmation step, so backing
     * out must leave the running timer exactly as it was. Pausing here would
     * silently steal focus time from a user who changed their mind.
     */
    function closeReasonPrompt() {
      store.set(Object.assign({}, store.get(), { reasonPrompt: null }))
    }

    /** Dismiss the completion card. */
    function dismissCard() {
      store.set(Object.assign({}, store.get(), { card: null }))
    }

    /** Abandon the current run outright, recording it as `aborted`. */
    async function stopRun() {
      var state = store.get()
      if (state.status === 'idle') return
      var now = Date.now()
      var elapsed = elapsedMsOf(state, now)
      if (state.settings.recordAborted && state.phase === 'focus' && elapsed > INTERRUPT_FLOOR_MS) {
        await persistRun(buildRecord(state, 'aborted', now, { focusedMs: elapsed }))
      }
      enterPhase(state.phase, { autoStart: false })
      store.set(Object.assign({}, store.get(), { notice: '', reasonPrompt: null }))
    }

    /** Reset the dial back to a full focus phase without recording anything. */
    function resetRun() {
      var state = store.get()
      store.set(Object.assign({}, state, { card: null, reasonPrompt: null }))
      enterPhase('focus', { autoStart: false })
    }

    /**
     * Jump to the next phase. A skip is not a completion, so it never advances
     * the long-break cadence — only a genuinely finished focus run does.
     */
    async function skipRun() {
      var state = store.get()
      var now = Date.now()
      var isFocus = state.phase === 'focus'
      if (state.status !== 'idle' && state.settings.recordAborted && isFocus) {
        var elapsed = elapsedMsOf(state, now)
        if (elapsed > INTERRUPT_FLOOR_MS) {
          await persistRun(buildRecord(state, 'skipped', now, { focusedMs: elapsed }))
        }
      }
      enterPhase(nextPhaseAfter(state.phase, state.cycleFocusCount), {
        autoStart: state.settings.autoStartNext === true,
      })
    }

    /** Start the next phase from the completion card. */
    function startNextFromCard() {
      var state = store.get()
      var card = state.card
      store.set(Object.assign({}, state, { card: null }))
      if (card === null || state.status === 'running') return
      startRun()
    }

    /** Choose the project for the next runs. */
    function setProject(name, source, sessionId) {
      var state = store.get()
      store.set(
        Object.assign({}, state, {
          project: {
            name: String(name || '').slice(0, 120),
            source: source || 'manual',
            sessionId: sessionId || '',
          },
        }),
      )
      saveActiveRun(store.get())
    }

    /** Load the host suggestion for the active Session into the store. */
    async function refreshSuggestion() {
      var sessionId = store.get().activeSessionId
      if (sessionId === '') return
      var result = await api.context(sessionId)
      if (result && result.ok === true) {
        store.set(Object.assign({}, store.get(), { suggestion: result.value }))
      }
    }

    //#endregion

    //#region components

    /**
     * Tomato mark for the sidebar rail and the status bar.
     *
     * Deliberately the same visual language as the shipped outline icons
     * (`viewBox="0 0 16 16"`, `fill="none"`, 1px `currentColor` stroke): a
     * fleshed-out solid silhouette looked out of place next to the line-art
     * icons for Plugins, Schedule and Session Stats.
     *
     * The remaining time is NOT drawn here — at rail size it is illegible. The
     * countdown lives in the status bar, and the panel owns the dial.
     */
    function Tomato(props) {
      var size = typeof props.size === 'number' ? props.size : 16
      // While a focus run is live the body is filled so it registers at a
      // glance without becoming a different kind of icon.
      var running = props.running === true
      var strokeWidth = size <= 14 ? 1.1 : 1
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          className: 'dshp-tomato',
          'aria-hidden': 'true',
          focusable: 'false',
          strokeWidth: strokeWidth,
        },
        // Body spans most of the 16-unit box on purpose: a smaller circle reads
        // as a stray dot beside the shipped outline icons, which fill their box.
        h('path', {
          key: 'body',
          fill: running ? 'currentColor' : 'none',
          fillOpacity: running ? 0.22 : 0,
          stroke: 'currentColor',
          strokeLinejoin: 'round',
          d:
            'M8 3.5c3.1 0 5.5 2.3 5.5 5.3 0 3.25-2.45 5.6-5.5 5.6S2.5 12.05 2.5 8.8C2.5 5.8 4.9 3.5 8 3.5Z',
        }),
        // Calyx: the stem and its two leaves, as line art so it survives 16px.
        h('path', {
          key: 'calyx',
          stroke: 'currentColor',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          d: 'M8 3.3V1.2',
        }),
        h('path', {
          key: 'leafL',
          stroke: 'currentColor',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          d: 'M7.85 3.4 4.7 1.7',
        }),
        h('path', {
          key: 'leafR',
          stroke: 'currentColor',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          d: 'M8.15 3.4l3.15-1.7',
        }),
      )
    }

    /** Sidebar rail entry: the tomato mark; the body fills while running. */
    function Glyph(props) {
      var state = useStore(store)
      var size = typeof props.size === 'number' ? props.size : 16
      var running = state.status === 'running' && state.settings.showBadgeInSidebar !== false
      return h(Tomato, { size: size, running: running })
    }

    /**
     * A vertical stack of tomatoes — one per completed pomodoro. Used as the
     * bar in the daily and hour charts so a day "is" its pomodoros. Beyond
     * `cap` the remainder folds into a `+N` badge on top.
     */
    function TomatoStack(props) {
      var count = Math.max(0, Math.floor(Number(props.count) || 0))
      var cap = Math.max(1, Math.floor(Number(props.cap) || 8))
      var shown = Math.min(count, cap)
      var size = typeof props.size === 'number' ? props.size : 14
      var stack = []
      if (count > cap) {
        stack.push(h('span', { key: 'more', className: 'dshp-tomatoStackMore' }, '+' + (count - cap)))
      }
      for (var i = 0; i < shown; i += 1) {
        stack.push(h('span', { key: i, className: 'dshp-tomatoStackItem', style: { fontSize: size + 'px', lineHeight: 1 } }, '🍅'))
      }
      if (count === 0) {
        return h('div', { className: 'dshp-tomatoStackEmpty' })
      }
      return h('div', { className: 'dshp-tomatoStack' }, stack)
    }

    /** Renders nothing; publishes the Session the interviewer is looking at. */
    function SessionProbe(props) {
      var sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      React.useEffect(
        function () {
          if (sessionId === '' || store.get().activeSessionId === sessionId) return
          store.set(Object.assign({}, store.get(), { activeSessionId: sessionId }))
          void refreshSuggestion()
        },
        [sessionId],
      )
      return null
    }

    /**
     * Ambient status-bar pill: the tomato icon plus a live countdown, and
     * nothing else.
     *
     * The row deliberately stays quiet — no status dot, no project name, no
     * inline pause/stop buttons. Everything beyond "how long is left" lives in
     * the popover opened by clicking the pill (project, today's totals, phase,
     * and the controls), so the bar matches the density of the shipped
     * `会话统计` pills beside it.
     *
     * Sits at order -10 in `conversation.composer.dock`, ahead of that
     * statistics entry (order 0).
     */
    function StatusBarTimer(props) {
      var state = useStore(store)
      var [open, setOpen] = React.useState(false)
      // Clicking anywhere else closes the popover, matching a menu.
      var rootRef = React.useRef(null)
      React.useEffect(
        function () {
          if (!open) return undefined
          function onDocClick(event) {
            var root = rootRef.current
            if (root !== null && typeof root.contains === 'function' && root.contains(event.target)) return
            setOpen(false)
          }
          function onKey(event) {
            if (event.key === 'Escape') setOpen(false)
          }
          document.addEventListener('click', onDocClick)
          document.addEventListener('keydown', onKey)
          return function () {
            document.removeEventListener('click', onDocClick)
            document.removeEventListener('keydown', onKey)
          }
        },
        [open],
      )

      if (state.settings.showTimerInStatusBar !== true) return null

      var running = state.status === 'running'
      var stats = state.stats
      var today = stats === null ? null : stats.scope.today
      var project = effectiveProject(state)

      return h(
        'div',
        { className: 'dshp-dock', ref: rootRef },
        h(
          'button',
          {
            className: 'dshp-dockPill' + (running ? ' run' : ''),
            type: 'button',
            'aria-expanded': open ? 'true' : 'false',
            title: MSS[state.phase] + ' · ' + project + '（点击查看详情）',
            onClick: function () {
              setOpen(!open)
            },
          },
          h(Tomato, { size: 14, running: running }),
          h('span', { className: 'dshp-dockTime' }, clockText(state.remainingMs)),
        ),
        open
          ? h(
              'div',
              { className: 'dshp-dockCard' },
              h(
                'div',
                { className: 'dshp-dockRow' },
                h('span', { className: 'dshp-dockK' }, '正在专注'),
                h('span', { className: 'dshp-dockV', title: project }, project),
              ),
              h(
                'div',
                { className: 'dshp-dockRow' },
                h('span', { className: 'dshp-dockK' }, '当前阶段'),
                h('span', { className: 'dshp-dockV' }, MSS[state.phase] + ' · ' + clockText(state.remainingMs)),
              ),
              h(
                'div',
                { className: 'dshp-dockRow' },
                h('span', { className: 'dshp-dockK' }, '今日已专注'),
                h(
                  'span',
                  { className: 'dshp-dockV' },
                  today === null
                    ? '—'
                    : today.completed + ' 个番茄 · ' + humanMinutes(today.focusedMinutes),
                ),
              ),
              h(
                'div',
                { className: 'dshp-dockRow' },
                h('span', { className: 'dshp-dockK' }, '本轮已完成'),
                h('span', { className: 'dshp-dockV' }, state.cycleFocusCount + ' 个番茄'),
              ),
              h(
                'div',
                { className: 'dshp-dockActions' },
                running || state.status === 'paused'
                  ? h(
                      'button',
                      {
                        className: 'dshp-dockBtn',
                        type: 'button',
                        onClick: running ? pauseRun : startRun,
                      },
                      running ? '暂停' : '继续',
                    )
                  : h('button', { className: 'dshp-dockBtn primary', type: 'button', onClick: startRun }, '开始专注'),
                running || state.status === 'paused'
                  ? h('button', { className: 'dshp-dockBtn', type: 'button', onClick: stopRun }, '放弃')
                  : null,
              ),
            )
          : null,
      )
    }

    /**
     * Interruption reason prompt.
     *
     * Presets first (a reason is chosen while being interrupted, so it must be
     * one click), with free text as the escape hatch. Confirming with nothing
     * chosen still pauses; the interruption is then logged as unexplained.
     *
     * The selection lives in the STORE rather than in component state, so
     * opening the prompt always starts clean and a stale choice can never leak
     * into the next interruption.
     */
    function ReasonPrompt(props) {
      var state = useStore(store)
      var prompt = state.reasonPrompt
      if (prompt === null) return null

      var choice = typeof prompt.choice === 'string' ? prompt.choice : ''
      var custom = typeof prompt.custom === 'string' ? prompt.custom : ''
      var reason = custom.trim() !== '' ? custom.trim() : choice

      /** Patch the open prompt's selection in place. */
      function patch(partial) {
        var current = store.get().reasonPrompt
        if (current === null) return
        store.set(Object.assign({}, store.get(), { reasonPrompt: Object.assign({}, current, partial) }))
      }

      function submit() {
        void pauseWithReason(reason)
      }

      return h(
        'div',
        {
          className: 'dshp-prompt',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '记录中断原因',
          onKeyDown: function (event) {
            if (event.key === 'Escape') closeReasonPrompt()
          },
        },
        h(
          'div',
          { className: 'dshp-promptCard' },
          h('h3', { className: 'dshp-promptTitle' }, '记录这次中断'),
          h(
            'div',
            { className: 'dshp-promptSub' },
            '计时会在确认后暂停。这个番茄会保留，随时可以继续，完成后仍算完成。',
          ),
          h(
            'div',
            { className: 'dshp-reasons' },
            REASONS.map(function (preset) {
              return h(
                'button',
                {
                  key: preset,
                  className: 'dshp-reason' + (choice === preset && custom.trim() === '' ? ' on' : ''),
                  type: 'button',
                  onClick: function () {
                    patch({ choice: preset, custom: '' })
                  },
                },
                preset,
              )
            }),
          ),
          h(
            'div',
            { className: 'dshp-reasonCustom' },
            h('input', {
              className: 'dshp-input',
              value: custom,
              placeholder: '或自己描述原因…',
              autoFocus: true,
              onChange: function (event) {
                var value = event.target.value
                patch(value !== '' ? { custom: value, choice: '' } : { custom: '' })
              },
              onKeyDown: function (event) {
                if (event.key === 'Enter') submit()
              },
            }),
          ),
          h(
            'div',
            { className: 'dshp-promptActions' },
            h(
              'button',
              {
                className: 'dshp-btn',
                type: 'button',
                onClick: function () {
                  closeReasonPrompt()
                },
              },
              '取消',
            ),
            h('button', { className: 'dshp-btn primary', type: 'button', onClick: submit }, '记录并暂停'),
          ),
        ),
      )
    }

    /**
     * Phase-completion card.
     *
     * Deliberately persistent: it never auto-dismisses, because a notification
     * that vanishes on its own is exactly the one you miss while away from the
     * screen. It shows the live countdown of the phase that just started, so
     * the card and the timer agree.
     */
    function CompletionCard(props) {
      var state = useStore(store)
      var card = state.card
      if (card === null) return null

      // `focus-done` means a BREAK is now running, so the ring uses the break
      // colour; a finished break means focus is (about to be) next.
      var isBreak = card.kind === 'focus-done'
      var running = state.status === 'running'
      var nextPlanned = plannedMsOf(state.settings, card.nextPhase)
      // When a break is (about to be) running, surface the suggested activity.
      var breakActivity = isBreak ? state.currentBreakActivity : null
      return h(
        'div',
        { className: 'dshp-cards', role: 'status', 'aria-live': 'polite' },
        h(
          'div',
          { className: 'dshp-card2' + (isBreak ? '' : ' break') },
          h(
            'div',
            { className: 'dshp-cardHead' },
            h('h3', { className: 'dshp-cardTitle' }, card.title),
            h(
              'button',
              {
                className: 'dshp-cardClose',
                type: 'button',
                title: '关闭',
                'aria-label': '关闭通知',
                onClick: dismissCard,
              },
              '×',
            ),
          ),
          h('div', { className: 'dshp-cardBody' }, card.body),
          breakActivity
            ? h(
                'div',
                { className: 'dshp-cardActivity' },
                h('span', { className: 'dshp-cardActivityK' }, '休息建议：'),
                h('span', { className: 'dshp-cardActivityV' }, breakActivity),
              )
            : null,
          h(
            'div',
            { className: 'dshp-cardNext' },
            // The next phase's countdown as a ring, matching the panel dial.
            h(Dial, {
              size: 56,
              progress: 1 - Math.max(0, Math.min(1, state.remainingMs / nextPlanned)),
              remainingMs: state.remainingMs,
              break_: isBreak,
              paused: !running,
            }),
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
              h('span', null, card.nextLabel),
              h('span', { style: { opacity: 0.6, fontSize: '11px' } }, running ? '进行中' : '已暂停'),
            ),
          ),
          h(
            'div',
            { className: 'dshp-cardActions' },
            running
              ? h('button', { className: 'dshp-btn sm', type: 'button', onClick: pauseRun }, '暂停')
              : h('button', { className: 'dshp-btn sm primary', type: 'button', onClick: startNextFromCard }, '开始' + card.nextLabel.split(' ')[0]),
            h('button', { className: 'dshp-btn sm', type: 'button', onClick: dismissCard }, '知道了'),
          ),
        ),
      )
    }

    /**
     * Circular countdown dial.
     *
     * One component, two sizes: the panel's large dial (the digits sit INSIDE
     * the ring, which is itself the progress bar) and a compact version used on
     * the completion card and the status-bar popover, so every countdown in the
     * plugin reads the same way.
     *
     * @param size    - rendered box edge in px.
     * @param progress - 0..1, how much of the phase has elapsed.
     * @param break_  - true tints the ring with the success colour.
     * @param paused  - true dims the ring and freezes it.
     */
    function Dial(props) {
      var size = typeof props.size === 'number' ? props.size : 200
      var progress = Math.max(0, Math.min(1, Number(props.progress) || 0))
      var stroke = size <= 60 ? 4 : 10
      var r = (size - stroke) / 2
      var c = 2 * Math.PI * r
      var cls =
        'dshp-dial' + (size <= 60 ? ' dshp-miniDial' : '')
      return h(
        'div',
        { className: cls, style: { width: size + 'px', height: size + 'px' } },
        h(
          'svg',
          { viewBox: '0 0 ' + size + ' ' + size, 'aria-hidden': 'true', focusable: 'false' },
          h('circle', {
            cx: size / 2,
            cy: size / 2,
            r: r,
            fill: 'none',
            strokeWidth: stroke,
            className: 'dshp-dialTrack',
          }),
          h('circle', {
            cx: size / 2,
            cy: size / 2,
            r: r,
            fill: 'none',
            strokeWidth: stroke,
            strokeLinecap: 'round',
            className:
              'dshp-dialRing' + (props.break_ ? ' brk' : '') + (props.paused ? ' paused' : ''),
            strokeDasharray: c.toFixed(2),
            strokeDashoffset: (c * (1 - progress)).toFixed(2),
            transform: 'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')',
          }),
        ),
        h(
          'div',
          { className: 'dshp-dialCenter' },
          h('div', { className: 'dshp-dialTime' }, clockText(props.remainingMs)),
          props.sub ? h('div', { className: 'dshp-dialSub' }, props.sub) : null,
          // Optional in-ring control (e.g. the float's pause/resume button).
          props.control ? h('div', { className: 'dshp-dialControl' }, props.control) : null,
        ),
      )
    }

    /**
     * Draggable always-on-top floating timer.
     *
     * Two forms, toggled by `settings.floatCollapsed`:
     *  - expanded: a 260px window with a big dial, project, break suggestion and
     *    start/pause controls (the "full" panel mirror);
     *  - collapsed: a small clock badge (mini dial) that stays out of the way.
     *
     * Both dock bottom-right by default and remember their dragged position in
     * `settings.floatPosition`. The whole thing lives in the frame-wide overlay
     * so the countdown is visible regardless of which panel is open. It is
     * opt-in via `settings.showFloatingTimer`; when off it renders nothing.
     */
    function FloatingTimer(props) {
      var state = useStore(store)
      var settings = state.settings
      // Hooks run unconditionally (before any early return) so React keeps a
      // stable hook order across renders.
      var [drag, setDrag] = React.useState(null)
      var [projDraft, setProjDraft] = React.useState('')
      var [projEditing, setProjEditing] = React.useState(false)

      if (settings.showFloatingTimer !== true) return null

      var running = state.status === 'running'
      var isBreak = state.phase !== 'focus'
      var progress = state.plannedMs > 0 ? 1 - state.remainingMs / state.plannedMs : 0
      progress = Math.max(0, Math.min(1, progress))
      var project = effectiveProject(state)
      var collapsed = settings.floatCollapsed === true

      // Apply a floating-window setting: optimistic local update so the widget
      // reacts instantly (e.g. closing hides it immediately), then reconcile
      // with the host's normalized value.
      function applyFloat(partial) {
        var next = Object.assign({}, store.get().settings, partial)
        store.set(Object.assign({}, store.get(), { settings: next }))
        void api.settings(next).then(function (res) {
          if (res && res.ok === true) applyState(res.value)
        })
      }

      // Drag the widget: the whole window is the handle in collapsed form, and
      // the header bar is the handle in expanded form. Position persists on drop.
      function startDrag(event) {
        event.preventDefault()
        var startX = event.clientX
        var startY = event.clientY
        var origin = drag !== null ? drag : settings.floatPosition
        if (origin === null) {
          // First drag ever: seed from the widget's live rect so it can detach
          // from the corner without jumping.
          var el = event.currentTarget.closest && event.currentTarget.closest('.dshp-float')
          var rect = el ? el.getBoundingClientRect() : event.currentTarget.getBoundingClientRect()
          origin = { x: rect.left, y: rect.top }
        }
        var last = origin
        function move(moveEvent) {
          last = { x: Math.max(0, origin.x + (moveEvent.clientX - startX)), y: Math.max(0, origin.y + (moveEvent.clientY - startY)) }
          setDrag(last)
        }
        function up() {
          document.removeEventListener('pointermove', move)
          document.removeEventListener('pointerup', up)
          applyFloat({ floatPosition: last })
        }
        document.addEventListener('pointermove', move)
        document.addEventListener('pointerup', up)
      }

      var pos = drag !== null ? drag : settings.floatPosition
      // Off-screen rescue: a position saved on a larger/other monitor (or a
      // stale drag) can land the widget outside the viewport, where it can
      // neither be seen nor clicked. Clamp into view on every render.
      if (pos !== null && typeof window !== 'undefined' && window.innerWidth > 0) {
        var margin = 8
        var width = collapsed ? 150 : 220
        var height = collapsed ? 44 : 220
        var maxX = Math.max(margin, window.innerWidth - width - margin)
        var maxY = Math.max(margin, window.innerHeight - height - margin)
        pos = { x: Math.min(Math.max(margin, pos.x), maxX), y: Math.min(Math.max(margin, pos.y), maxY) }
      }
      var style = pos !== null
        ? { left: pos.x + 'px', top: pos.y + 'px', right: 'auto', bottom: 'auto' }
        : {}

      if (collapsed) {
        return h(
          'div',
          {
            className: 'dshp-float mini' + (isBreak ? ' brk' : ''),
            style: style,
            onPointerDown: startDrag,
          },
          h(
            'div',
            { className: 'dshp-floatMiniBar' },
            h(
              'button',
              {
                className: 'dshp-floatMiniBtn',
                type: 'button',
                title: '展开成大窗口',
                onPointerDown: function (e) { e.stopPropagation() },
                onClick: function () { applyFloat({ floatCollapsed: false }) },
              },
              h('span', { className: 'dshp-floatIcoExpand', 'aria-hidden': 'true' }),
            ),
            h(
              'button',
              {
                className: 'dshp-floatClose',
                type: 'button',
                title: '关闭悬浮窗（可在设置重新开启）',
                onPointerDown: function (e) { e.stopPropagation() },
                onClick: function () { applyFloat({ showFloatingTimer: false }) },
              },
              h('span', { className: 'dshp-floatIcoX', 'aria-hidden': 'true' }),
            ),
          ),
          // No leading play button in the collapsed bar — the digits alone are
          // the widget; the corner buttons handle everything else.
          h('span', { className: 'dshp-floatMiniTime' }, clockText(state.remainingMs)),
        )
      }

      // Expanded form: a strict square — one uniform surface (no split header),
      // the two window controls tucked into the top-right corner, and the
      // project as the only body content below the dial.
      return h(
        'div',
        {
          className: 'dshp-float' + (isBreak ? ' brk' : ''),
          style: style,
          onPointerDown: startDrag,
        },
        h(
          'div',
          { className: 'dshp-floatCorner' },
          h(
            'button',
            {
              className: 'dshp-floatMiniBtn',
              type: 'button',
              title: '收起为小角标',
              onPointerDown: function (e) { e.stopPropagation() },
              onClick: function () { applyFloat({ floatCollapsed: true }) },
            },
            h('span', { className: 'dshp-floatIcoMinus', 'aria-hidden': 'true' }),
          ),
          h(
            'button',
            {
              className: 'dshp-floatClose',
              type: 'button',
              title: '关闭悬浮窗（可在设置重新开启）',
              onPointerDown: function (e) { e.stopPropagation() },
              onClick: function () { applyFloat({ showFloatingTimer: false }) },
            },
            h('span', { className: 'dshp-floatIcoX', 'aria-hidden': 'true' }),
          ),
        ),
        h(
          'div',
          { className: 'dshp-floatBody' },
          h(Dial, {
            size: 150,
            progress: progress,
            remainingMs: state.remainingMs,
            break_: isBreak,
            paused: state.status === 'paused',
            control: h(
              'button',
              {
                className: 'dshp-floatPlay',
                type: 'button',
                title: running ? '暂停' : state.status === 'paused' ? '继续' : '开始',
                onPointerDown: function (e) { e.stopPropagation() },
                onClick: function () {
                  if (running) pauseRun()
                  else startRun()
                },
              },
              running ? '❚❚' : '▶',
            ),
          }),
          projEditing
            ? h(
                'div',
                { className: 'dshp-floatProjEdit' },
                h('input', {
                  className: 'dshp-input',
                  value: projDraft,
                  placeholder: state.settings.defaultProject,
                  autoFocus: true,
                  onChange: function (event) {
                    setProjDraft(event.target.value)
                  },
                  onKeyDown: function (event) {
                    if (event.key === 'Enter') {
                      setProject(projDraft, 'manual', '')
                      setProjEditing(false)
                      setProjDraft('')
                    } else if (event.key === 'Escape') {
                      setProjEditing(false)
                      setProjDraft('')
                    }
                  },
                }),
              )
            : h(
                'div',
                {
                  className: 'dshp-floatProj',
                  title: '点击可修改项目名称',
                  onClick: function () {
                    setProjDraft(project === state.settings.defaultProject ? '' : project)
                    setProjEditing(true)
                  },
                },
                project,
                h('span', { className: 'edit' + (project === state.settings.defaultProject ? ' dim' : '') }, '✎'),
              ),
        ),
      )
    }

    /** One metric tile. */
    function Metric(props) {
      return h(
        'div',
        { className: 'dshp-metric' },
        h('div', { className: 'dshp-metricK' }, props.k),
        h('div', { className: 'dshp-metricV' }, props.v),
        props.s ? h('div', { className: 'dshp-metricS' }, props.s) : null,
      )
    }

    /** Clock tab: the dial, the controls and the project chooser. */
    function TimerTab(props) {
      var state = useStore(store)
      var [draft, setDraft] = React.useState('')
      var [editing, setEditing] = React.useState(false)

      var project = effectiveProject(state)
      var source = state.project && state.project.source ? state.project.source : 'default'
      var progress = state.plannedMs > 0 ? 1 - state.remainingMs / state.plannedMs : 0
      progress = Math.max(0, Math.min(1, progress))
      var isBreak = state.phase !== 'focus'

      var candidates = []
      var seen = new Set()
      function pushCandidate(value, from) {
        if (typeof value !== 'string' || value.trim() === '') return
        var key = value.trim()
        if (seen.has(key)) return
        seen.add(key)
        candidates.push({ value: key, source: from })
      }
      if (state.suggestion !== null) {
        var list = state.suggestion.candidates || []
        for (var i = 0; i < list.length; i += 1) pushCandidate(list[i].value, list[i].source)
        pushCandidate(state.suggestion.project, 'workspace')
        pushCandidate(state.suggestion.title, 'session')
      }
      for (var j = 0; j < state.recentProjects.length && candidates.length < 10; j += 1) {
        pushCandidate(state.recentProjects[j].project, 'recent')
      }

      return h(
        'div',
        null,
        state.error ? h('div', { className: 'dshp-msg err' }, state.error) : null,
        state.notice && state.status === 'idle' ? h('div', { className: 'dshp-msg ok' }, state.notice) : null,
        h(
          'div',
          { className: 'dshp-card' },
          h(
            'div',
            { className: 'dshp-clockWrap' },
            h('span', { className: 'dshp-phase ' + state.phase }, MSS[state.phase]),
            // The ring IS the progress bar; the digits and the project sit
            // inside it so the dial is one object, not clock plus a strip.
            h(Dial, {
              size: 200,
              progress: progress,
              remainingMs: state.remainingMs,
              break_: isBreak,
              paused: state.status === 'paused',
              sub: project + ' · ' + (SOURCE_LABELS[source] || source),
            }),
            h(
              'div',
              { className: 'dshp-btns' },
              state.status === 'running'
                ? h('button', { className: 'dshp-btn primary', type: 'button', onClick: pauseRun }, '暂停')
                : h(
                    'button',
                    { className: 'dshp-btn primary', type: 'button', onClick: startRun },
                    state.status === 'paused' ? '继续' : '开始专注',
                  ),
              h(
                'button',
                {
                  className: 'dshp-btn',
                  type: 'button',
                  disabled: state.status === 'idle',
                  title: '暂停并记录这次中断的原因；番茄保留，可随时继续',
                  onClick: openReasonPrompt,
                },
                '暂停并记录中断',
              ),
              h('button', { className: 'dshp-btn', type: 'button', onClick: skipRun }, '跳过'),
              h('button', { className: 'dshp-btn', type: 'button', onClick: resetRun }, '重置'),
              h(
                'button',
                { className: 'dshp-btn danger', type: 'button', disabled: state.status === 'idle', onClick: stopRun },
                '放弃这个番茄',
              ),
            ),
            h(
              'div',
              { className: 'dshp-note' },
              '本轮已完成 ' +
                state.cycleFocusCount +
                ' 个番茄，每 ' +
                state.settings.longBreakEvery +
                ' 个进入长休息。' +
                (state.interruptions > 0 ? ' 本次专注已中断 ' + state.interruptions + ' 次。' : ''),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dshp-card' },
          h('div', { className: 'dshp-cardTitle' }, '项目 / 任务'),
          editing
            ? h(
                'div',
                { className: 'dshp-row' },
                h(
                  'div',
                  { className: 'dshp-field' },
                  h('span', { className: 'dshp-label' }, '手动输入项目名'),
                  h('input', {
                    className: 'dshp-input',
                    value: draft,
                    placeholder: state.settings.defaultProject,
                    autoFocus: true,
                    onChange: function (event) {
                      setDraft(event.target.value)
                    },
                    onKeyDown: function (event) {
                      if (event.key === 'Enter') {
                        setProject(draft, 'manual', '')
                        setEditing(false)
                      }
                    },
                  }),
                ),
                h('button', {
                  className: 'dshp-btn primary',
                  type: 'button',
                  onClick: function () {
                    setProject(draft, 'manual', '')
                    setEditing(false)
                  },
                }, '确定'),
                h('button', {
                  className: 'dshp-btn',
                  type: 'button',
                  onClick: function () {
                    setEditing(false)
                  },
                }, '取消'),
              )
            : h(
                'div',
                null,
                candidates.length > 0
                  ? h(
                      'div',
                      { className: 'dshp-chips', style: { marginBottom: '10px' } },
                      candidates.map(function (candidate, index) {
                        return h(
                          'button',
                          {
                            key: candidate.value + ':' + index,
                            className: 'dshp-chip' + (candidate.value === project ? ' on' : ''),
                            type: 'button',
                            title: '来源：' + (SOURCE_LABELS[candidate.source] || candidate.source),
                            onClick: function () {
                              setProject(
                                candidate.value,
                                candidate.source,
                                candidate.source === 'session' ? state.activeSessionId : '',
                              )
                            },
                          },
                          candidate.value,
                        )
                      }),
                    )
                  : h('div', { className: 'dshp-empty' }, state.activeSessionId === '' ? '尚未关联会话，可手动输入项目名。' : '正在解析当前会话…'),
                h(
                  'div',
                  { className: 'dshp-row', style: { marginTop: '8px' } },
                  h('button', {
                    className: 'dshp-btn sm',
                    type: 'button',
                    onClick: function () {
                      setDraft(project)
                      setEditing(true)
                    },
                  }, '手动输入'),
                  h('button', {
                    className: 'dshp-btn sm',
                    type: 'button',
                    disabled: state.activeSessionId === '',
                    onClick: function () {
                      void refreshSuggestion()
                    },
                  }, '刷新当前会话'),
                  h('button', {
                    className: 'dshp-btn sm',
                    type: 'button',
                    onClick: function () {
                      setProject('', 'default', '')
                    },
                  }, '使用默认名'),
                ),
                h(
                  'div',
                  { className: 'dshp-note', style: { marginTop: '8px' } },
                  state.suggestion !== null && state.suggestion.cwd
                    ? '当前会话目录：' + state.suggestion.cwd
                    : '提示：在对话中打开会话后，这里会自动带出该会话的工作区名与标题。',
                ),
              ),
        ),
      )
    }

    /**
     * GitHub-style contribution heatmap over the trailing year.
     *
     * The host sends a DENSE day grid (every calendar day, zeros included) laid
     * out as week columns, so this only has to pick a colour level per cell.
     * Levels are relative to the busiest day in the window, which is what makes
     * a personal baseline readable.
     */
    function Heatmap(props) {
      var heatmap = props.heatmap
      if (heatmap === null || heatmap === undefined || !Array.isArray(heatmap.columns) || heatmap.columns.length === 0) {
        return h('div', { className: 'dshp-empty' }, '还没有记录。')
      }

      /** 0 = nothing, 1-4 = increasing intensity relative to `max`. */
      function levelOf(completed, max) {
        if (completed <= 0) return 0
        if (max <= 1) return 4
        var ratio = completed / max
        if (ratio <= 0.25) return 1
        if (ratio <= 0.5) return 2
        if (ratio <= 0.75) return 3
        return 4
      }

      function cellTitle(cell) {
        var label = cell.date + '：' + (cell.completed === 0 ? '无完成记录' : cell.completed + ' 个番茄')
        if (cell.focusedMinutes > 0) label += ' · ' + humanMinutes(cell.focusedMinutes)
        return label
      }

      var months = Array.isArray(heatmap.months) ? heatmap.months : []
      var max = Number(heatmap.max) || 0

      // Weekday labels down the left edge. Columns read Mon..Sun, so the rows
      // are 一/二/三/四/五/六/日 top to bottom; we surface 一/三/五/日 and hide
      // the rest (GitHub's own sparse rhythm).
      var DOW_LABELS = ['一', '二', '三', '四', '五', '六', '日']

      return h(
        'div',
        { className: 'dshp-heatWrap', style: { flexDirection: 'column' } },
        // The month band spans the FULL width so its height is shared by the
        // label column and the grid below — that shared offset is what keeps
        // 一 aligned with the first row of cells.
        // The month band mirrors the grid structurally: same left offset as
        // the grid (dow column + gap), same 53 flex columns with the same
        // gap. A label is written INTO its exact column slot, so it can never
        // drift to a neighbouring month however the card width changes.
        h(
          'div',
          { className: 'dshp-heatMonths' },
          heatmap.columns.map(function (column) {
            var entry = null
            for (var m = 0; m < months.length; m += 1) {
              if (months[m].column === column.index) {
                entry = months[m]
                break
              }
            }
            return h(
              'span',
              { key: 'mcol-' + column.index, className: 'dshp-heatMonthSlot' },
              entry !== null ? h('span', { className: 'dshp-heatMonth' }, entry.label) : null,
            )
          }),
        ),
        h(
          'div',
          { className: 'dshp-heatCols' },
          // 星期标签与网格同处此行、且此行不含图例，标签列才能拉伸到网格高度——一/日 就精确落在首末行格子。
          h(
            'div',
            { className: 'dshp-heatDows', 'aria-hidden': 'true' },
            DOW_LABELS.map(function (label, index) {
              return h('span', { key: label, className: 'dshp-heatDow' }, label)
            }),
          ),
          h(
            'div',
            { className: 'dshp-heat' },
            heatmap.columns.map(function (column) {
              return h(
                'div',
                { key: column.index, className: 'dshp-heatCol' },
                column.cells.map(function (cell) {
                  var level = cell.future ? -1 : levelOf(cell.completed, max)
                  var cls = 'dshp-heatCell' + (level > 0 ? ' l' + level : '') + (cell.future ? ' future' : '')
                  return h('div', { key: cell.date, className: cls, title: cellTitle(cell) })
                }),
              )
            }),
          ),
        ),
        h(
          'div',
          { className: 'dshp-heatLegend' },
          h('span', null, '少'),
          h('div', { className: 'dshp-heatCell' }),
          h('div', { className: 'dshp-heatCell l1' }),
          h('div', { className: 'dshp-heatCell l2' }),
          h('div', { className: 'dshp-heatCell l3' }),
          h('div', { className: 'dshp-heatCell l4' }),
          h('span', null, '多'),
          h('span', { style: { marginLeft: '12px' } }, '活跃 ' + heatmap.activeDays + ' 天'),
          h('span', { className: 'dshp-dockSep' }, '·'),
          h('span', null, '共 ' + heatmap.totalCompleted + ' 个番茄'),
          h('span', { style: { marginLeft: '12px' } }, '单日最高 ' + max + ' 个'),
        ),
      )
    }

    /** Statistics tab: scopes, yearly heatmap, per-project share and hour distribution. */
    function StatsTab(props) {
      var state = useStore(store)
      var stats = state.stats
      var scopeKey = props.scopeKey

      var projects = stats && Array.isArray(stats.projects) ? stats.projects.slice(0, 12) : []
      // Hour distribution follows the selected scope: the stored `byHour` is
      // global (all-time), so we filter the focus records to the chosen window
      // and re-bucket completed runs per local hour here.
      var byHour = new Array(24).fill(0)
      var allRecords = state.records
      if (Array.isArray(allRecords)) {
        var scopeFloor = scopeKey === 'today' ? startOfDayMs(stats.now) : scopeKey === 'week' ? startOfWeekMs(stats.now) : scopeKey === 'month' ? startOfMonthMs(stats.now) : 0
        for (var r = 0; r < allRecords.length; r += 1) {
          var rec = allRecords[r]
          if (rec.phase !== 'focus' || rec.status !== 'completed') continue
          if (scopeFloor > 0 && rec.startedAt < scopeFloor) continue
          byHour[new Date(rec.startedAt).getHours()] += 1
        }
      }

      // Per-day chart for the CURRENT week (Monday..Sunday), always seven
      // columns so the shape of a week is comparable at a glance. Built from the
      // same dense day series the heatmap uses, so the two never disagree.
      var weekDays = []
      var weekPeak = 1
      var weekTotal = 0
      var weekMinutes = 0
      if (stats && stats.heatmap && Array.isArray(stats.heatmap.columns)) {
        var todayKey = stats.today
        // The heatmap's last column is the current week; walk it Monday-first.
        var current = stats.heatmap.columns[stats.heatmap.columns.length - 1]
        var cells = current ? current.cells : []
        for (var d = 0; d < cells.length; d += 1) {
          var cell = cells[d]
          // Future days ARE included, just greyed: dropping them would leave
          // the week with a ragged set of weekday labels (3 columns today,
          // 7 on Sunday), which is exactly the "星期不全" bug.
          var weekday = (new Date(cell.time).getDay() + 6) % 7
          weekDays.push({
            key: cell.date,
            completed: cell.completed,
            focusedMinutes: cell.focusedMinutes,
            weekday: weekday,
            isToday: cell.date === todayKey,
            future: cell.future,
          })
          if (cell.future) continue
          if (cell.completed > weekPeak) weekPeak = cell.completed
          weekTotal += cell.completed
          weekMinutes += cell.focusedMinutes
        }
        if (weekPeak < 1) weekPeak = 1
      }

      if (stats === null) return h('div', { className: 'dshp-empty' }, state.loading ? '正在载入统计…' : '暂无统计数据。')

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'dshp-grid', style: { marginBottom: '12px' } },
          h(Metric, { k: '今日完成', v: String(stats.scope.today.completed), s: humanMinutes(stats.scope.today.focusedMinutes) }),
          h(Metric, { k: '本周完成', v: String(stats.scope.week.completed), s: humanMinutes(stats.scope.week.focusedMinutes) }),
          h(Metric, { k: '本月完成', v: String(stats.scope.month.completed), s: humanMinutes(stats.scope.month.focusedMinutes) }),
          h(Metric, {
            k: '累计专注',
            v: String(Math.round((stats.scope.total.focusedMinutes / 60) * 10) / 10) + 'h',
            s: stats.scope.total.completed + ' 个番茄 · 中断 ' + stats.scope.total.interruptions + ' 次',
          }),
          h(Metric, { k: '连续打卡', v: String(stats.streakDays) + ' 天', s: '日均 ' + stats.baselineCompleted + ' 个' }),
        ),
        h(
          'div',
          { className: 'dshp-card' },
          h('div', { className: 'dshp-cardTitle' }, '全年专注热力图（近 365 天）'),
          h(Heatmap, { heatmap: stats.heatmap }),
        ),
        h(
          'div',
          { className: 'dshp-split' },
          h(
            'div',
            { className: 'dshp-card' },
            h('div', { className: 'dshp-cardTitle' }, '本周每日专注'),
            weekDays.length === 0
              ? h('div', { className: 'dshp-empty' }, '还没有记录。')
              : h(
                  'div',
                  { className: 'dshp-chart' },
                  weekDays.map(function (day) {
                    var total = day.completed
                    return h(
                      'div',
                      {
                        key: day.key,
                        className: 'dshp-col',
                        style: day.future ? { opacity: 0.35 } : undefined,
                        title:
                          day.key +
                          '：完成 ' +
                          day.completed +
                          ' 个番茄 · ' +
                          day.focusedMinutes +
                          ' 分钟' +
                          (day.future ? '（尚未到来）' : ''),
                      },
                      h(TomatoStack, { count: total, cap: 10, size: 15 }),
                      h(
                        'div',
                        { className: 'dshp-colK', style: day.isToday ? { color: 'var(--dsw-alias-label-primary)', fontWeight: 600 } : undefined },
                        WEEKDAYS[day.weekday],
                      ),
                    )
                  }),
                ),
          h(
            'div',
            { className: 'dshp-note', style: { marginTop: '8px' } },
            '本周 ' + weekTotal + ' 个番茄 · ' + humanMinutes(weekMinutes) + '，高峰 ' + weekPeak + ' 个/天。',
          ),
        ),
        h(
          'div',
          { className: 'dshp-card' },
          h('div', { className: 'dshp-cardTitle' }, '时段分布（' + ({ today: '今日', week: '本周', month: '本月', total: '累计' }[scopeKey] || '') + '）'),
          h(
            'div',
            { className: 'dshp-chart' },
            byHour.map(function (count, hour) {
              // Tick at 0/6/12/18 — four evenly spaced anchors read as a clock.
              // Labelling every third hour left ragged gaps that read as a bug.
              var show = hour % 6 === 0 || hour === 23
              return h(
                'div',
                { key: hour, className: 'dshp-col', title: pad2(hour) + ':00 — ' + count + ' 个' },
                h(TomatoStack, { count: count, cap: 8, size: 13 }),
                h('div', { className: 'dshp-colK' }, show ? String(hour) : ''),
              )
            }),
          ),
        ),
      ),
        h(
          'div',
          { className: 'dshp-card' },
          h('div', { className: 'dshp-cardTitle' }, '项目分布'),
          projects.length === 0
            ? h('div', { className: 'dshp-empty' }, '暂无项目数据。')
            : h(
                'table',
                { className: 'dshp-table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', null, '项目'),
                    h('th', { className: 'num' }, '番茄'),
                    h('th', { className: 'num' }, '专注'),
                    h('th', { className: 'num' }, '占比'),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  projects.map(function (project) {
                    return h(
                      'tr',
                      { key: project.project },
                      h('td', { title: project.project }, project.project),
                      h('td', { className: 'num' }, String(project.completed)),
                      h('td', { className: 'num' }, project.focusedMinutes + 'm'),
                      h('td', { className: 'num' }, project.sharePercent + '%'),
                    )
                  }),
                ),
              ),
        ),
      )
    }

    /** Records tab: the raw log with per-row deletion. */
    function RecordsTab(props) {
      var state = useStore(store)
      var [limit, setLimit] = React.useState(10)
      var records = state.records
      var visible = React.useMemo(
        function () {
          return records.slice().sort(function (a, b) {
            return b.startedAt - a.startedAt
          }).slice(0, limit)
        },
        [records, limit],
      )

      var [from, setFrom] = React.useState('')
      var [to, setTo] = React.useState('')
      var [busy, setBusy] = React.useState('')

      if (records.length === 0) return h('div', { className: 'dshp-empty' }, '还没有任何记录。')

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'dshp-card' },
          h('div', { className: 'dshp-cardTitle' }, '导出 Excel 可读的 CSV'),
          h(
            'div',
            { className: 'dshp-row' },
            h(
              'div',
              { className: 'dshp-field' },
              h('span', { className: 'dshp-label' }, '起始日期'),
              h('input', {
                className: 'dshp-input',
                type: 'date',
                value: from,
                onChange: function (event) {
                  setFrom(event.target.value)
                },
              }),
            ),
            h(
              'div',
              { className: 'dshp-field' },
              h('span', { className: 'dshp-label' }, '结束日期'),
              h('input', {
                className: 'dshp-input',
                type: 'date',
                value: to,
                onChange: function (event) {
                  setTo(event.target.value)
                },
              }),
            ),
            h(
              'button',
              {
                className: 'dshp-btn primary',
                type: 'button',
                onClick: function () {
                  var link = document.createElement('a')
                  link.href = exportUrl(from, to)
                  link.download = ''
                  document.body.appendChild(link)
                  link.click()
                  link.remove()
                  setBusy('已开始下载 CSV（UTF-8 BOM，Excel 可直接打开）。')
                },
              },
              '导出 CSV',
            ),
          ),
          h(
            'div',
            { className: 'dshp-note', style: { marginTop: '8px' } },
            '留空日期则导出全部记录。文件含汇总、按日、按项目、中断原因与逐条明细五个区块。',
          ),
          busy ? h('div', { className: 'dshp-msg ok', style: { marginTop: '8px', marginBottom: 0 } }, busy) : null,
        ),
        h(
          'div',
          { className: 'dshp-card' },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', marginBottom: '8px' } },
            h('div', { className: 'dshp-cardTitle', style: { margin: 0 } }, '记录明细（最近 10 条 · 共 ' + records.length + ' 条）'),
            h('div', { className: 'dshp-spacer' }),
            h(
              'button',
              {
                className: 'dshp-btn sm danger',
                type: 'button',
                onClick: async function () {
                  if (!window.confirm('确定清空全部番茄钟记录吗？此操作不可撤销（设置会保留）。')) return
                  var result = await api.clear('all')
                  if (result && result.ok === true) applyState(result.value)
                },
              },
              '清空全部',
            ),
          ),
          // Column header FIRST, so the 中断原因 column is discoverable: a
          // column that only appears when a row has a reason reads as missing.
          h(
            'div',
            { className: 'dshp-recRow dshp-recHead' },
            h('span', { className: 'dshp-recTime' }, '时间'),
            h('span', { className: 'dshp-recProj' }, '项目'),
            h('span', { className: 'dshp-reasonTag dshp-reasonHead' }, '中断原因'),
            h('span', { className: 'dshp-recTime dshp-recPhase' }, '阶段'),
            h('span', { className: 'dshp-recTime dshp-recDur' }, '时长'),
            h('span', { className: 'dshp-pill dshp-recStateHead' }, '状态'),
            h('span', { className: 'dshp-recAction' }, ''),
          ),
          visible.map(function (record) {
            // Interruptions carry the SAME accent as the completion card, so
            // "中断" is one colour across the whole plugin.
            var isInterruption = record.status === 'interrupted' || record.status === 'aborted'
            var statusLabel =
              record.status === 'completed'
                ? '完成'
                : record.status === 'aborted'
                  ? '中断'
                  : record.status === 'interrupted'
                    ? '中断(已继续)'
                    : '跳过'
            // The reason is a first-class COLUMN: every row emits it, empty or
            // not, so the column exists even when nothing was recorded yet.
            return h(
              'div',
              {
                className: 'dshp-recRow' + (isInterruption ? ' dshp-recRowInterrupted' : ''),
                key: record.id,
              },
              h('span', { className: 'dshp-recTime' }, stampText(record.startedAt)),
              h('span', { className: 'dshp-recProj', title: record.project }, record.project),
              h(
                'span',
                {
                  className: 'dshp-reasonTag' + (record.reason ? '' : ' dshp-reasonEmpty'),
                  title: isInterruption
                    ? record.reason
                      ? '中断原因：' + record.reason
                      : '中断原因：未记录'
                    : '只有中断会记录原因',
                },
                isInterruption ? record.reason || '—' : '—',
              ),
              h('span', { className: 'dshp-recTime dshp-recPhase' }, MSS[record.phase]),
              h('span', { className: 'dshp-recTime dshp-recDur' }, Math.round(record.focusedMs / 60000) + 'm'),
              h('span', { className: 'dshp-pill ' + record.status }, statusLabel),
              h(
                'button',
                {
                  className: 'dshp-btn sm dshp-recAction',
                  type: 'button',
                  title: '删除这条记录',
                  onClick: async function () {
                    var result = await api.remove(record.id)
                    if (result && result.ok === true) applyState(result.value)
                  },
                },
                '删除',
              ),
            )
          }),
          visible.length < records.length
            ? h(
                'div',
                { style: { textAlign: 'center', paddingTop: '10px' } },
                h(
                  'button',
                  {
                    className: 'dshp-btn sm',
                    type: 'button',
                    onClick: function () {
                      setLimit(limit + 120)
                    },
                  },
                  '显示更多',
                ),
              )
            : null,
        ),
      )
    }

    /** Settings tab. Every patch is normalized host-side, so the UI can be loose. */
    /**
     * Editable list of break-activity suggestions. Each entry is a free-text line;
     * add / remove / edit inline. Commits through the same `commit` channel the
     * rest of Settings uses, so the host persists and broadcasts the change.
     */
    function BreakActivitiesEditor(props) {
      var settings = props.settings
      var commit = props.commit
      var list = Array.isArray(settings.breakActivities) ? settings.breakActivities : []
      var [draft, setDraft] = React.useState('')

      function replace(next) {
        void commit({ breakActivities: next })
      }
      function updateAt(index, value) {
        var next = list.slice()
        next[index] = value
        replace(next)
      }
      function removeAt(index) {
        replace(list.filter(function (_, i) {
          return i !== index
        }))
      }
      function addOne() {
        var value = draft.trim().replace(/\s+/g, ' ')
        if (value === '') return
        setDraft('')
        replace(list.concat([value]))
      }

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'dshp-actList' },
          list.length === 0
            ? h('div', { className: 'dshp-empty' }, '列表为空，休息时将不推荐具体活动。')
            : list.map(function (value, index) {
                return h(
                  'div',
                  { key: index, className: 'dshp-actRow' },
                  h('input', {
                    className: 'dshp-input',
                    value: value,
                    onChange: function (event) {
                      updateAt(index, event.target.value)
                    },
                  }),
                  h(
                    'button',
                    {
                      className: 'dshp-btn sm danger',
                      type: 'button',
                      title: '删除这条',
                      onClick: function () {
                        removeAt(index)
                      },
                    },
                    '删除',
                  ),
                )
              }),
        ),
        h(
          'div',
          { className: 'dshp-row', style: { marginTop: '10px' } },
          h(
            'div',
            { className: 'dshp-field', style: { marginBottom: 0 } },
            h('input', {
              className: 'dshp-input',
              value: draft,
              placeholder: '例如：深蹲十个 / 喝一杯水 / 自己写一句',
              onChange: function (event) {
                setDraft(event.target.value)
              },
              onKeyDown: function (event) {
                if (event.key === 'Enter') addOne()
              },
            }),
          ),
          h('button', { className: 'dshp-btn sm primary', type: 'button', onClick: addOne }, '添加'),
        ),
      )
    }

    function SettingsTab(props) {
      var state = useStore(store)
      var [saving, setSaving] = React.useState(false)
      var [saved, setSaved] = React.useState('')

      function patch(partial) {
        var next = Object.assign({}, state.settings, partial)
        store.set(Object.assign({}, store.get(), { settings: next }))
        return next
      }

      async function commit(partial) {
        var next = patch(partial)
        setSaving(true)
        var result = await api.settings(next)
        setSaving(false)
        if (result && result.ok === true) {
          applyState(result.value)
          setSaved('已保存')
          setTimeout(function () {
            setSaved('')
          }, 1600)
        } else {
          store.set(Object.assign({}, store.get(), { error: '设置保存失败：' + describeError(result) }))
        }
      }

      function numberField(key, label, min, max) {
        return h(
          'div',
          { className: 'dshp-field' },
          h('span', { className: 'dshp-label' }, label),
          h('input', {
            className: 'dshp-input',
            type: 'number',
            min: min,
            max: max,
            value: state.settings[key],
            onChange: function (event) {
              patch((function () {
                var partial = {}
                partial[key] = Number(event.target.value)
                return partial
              })())
            },
            onBlur: function () {
              void commit({})
            },
          }),
        )
      }

      function toggle(key, label) {
        return h(
          'label',
          { className: 'dshp-check', key: key },
          h('input', {
            type: 'checkbox',
            checked: state.settings[key] === true,
            onChange: function (event) {
              void commit((function () {
                var partial = {}
                partial[key] = event.target.checked
                return partial
              })())
            },
          }),
          h('span', null, label),
        )
      }

      return h(
        'div',
        null,
        saved ? h('div', { className: 'dshp-msg ok' }, saved) : null,
        h(
          'div',
          { className: 'dshp-card' },
          h('div', { className: 'dshp-cardTitle' }, '时长（分钟）'),
          h(
            'div',
            { className: 'dshp-row' },
            numberField('focusMinutes', '专注', 1, 180),
            numberField('shortBreakMinutes', '短休息', 1, 60),
            numberField('longBreakMinutes', '长休息', 1, 120),
            numberField('longBreakEvery', '每几个番茄长休息', 1, 12),
          ),
        ),
        h(
          'div',
          { className: 'dshp-card' },
          h('div', { className: 'dshp-cardTitle' }, '行为'),
          toggle('autoStartBreak', '专注结束后自动开始休息倒计时（默认开启）'),
          toggle('autoStartNext', '休息结束后自动开始下一个专注（默认关闭，手动更可控）'),
          toggle('recordAborted', '记录中断（单独统计，不计入完成数）'),
          toggle('recordBreaks', '同时记录休息阶段'),
          toggle('cardEnabled', '阶段结束时在界面右下角弹出通知卡片'),
          toggle('soundEnabled', '阶段结束时播放提示音'),
          toggle('notifyEnabled', '阶段结束时发送系统通知'),
          saving ? h('div', { className: 'dshp-note' }, '正在保存…') : null,
        ),
        h(
          'div',
          { className: 'dshp-card' },
          h('div', { className: 'dshp-cardTitle' }, '显示位置'),
          toggle('showTimerInStatusBar', '在输入框下方的状态栏显示计时（位于「会话统计」之前）'),
          toggle('showBadgeInSidebar', '专注进行时把侧边栏番茄图标填充'),
          toggle('showFloatingTimer', '常驻右下角悬浮计时窗（可拖拽，独立显示当前番茄钟）'),
          toggle('floatCollapsed', '默认以小角标形式显示（点角标上的方块可展开成大窗口）'),
          h(
            'div',
            { className: 'dshp-note' },
            '状态栏只显示番茄图标 + 跳动的时间；点它可展开当前项目、今日已专注番茄数与控制按钮。悬浮窗是额外的常驻小窗：大窗口可收起成右上的小角标，小角标也能拖动；右上角 × 可随时关闭（可在设置重新开启）。',
          ),
        ),
        h(
          'div',
          { className: 'dshp-card' },
          h('div', { className: 'dshp-cardTitle' }, '默认项目名'),
          h('div', { className: 'dshp-row' },
            h(
              'div',
              { className: 'dshp-field' },
              h('span', { className: 'dshp-label' }, '既未关联会话也未手动输入时使用'),
              h('input', {
                className: 'dshp-input',
                value: state.settings.defaultProject,
                onChange: function (event) {
                  patch({ defaultProject: event.target.value })
                },
                onBlur: function () {
                  void commit({})
                },
              }),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dshp-card' },
          h('div', { className: 'dshp-cardTitle' }, '休息时的活动建议'),
          h(
            'div',
            { className: 'dshp-note', style: { marginBottom: '10px' } },
            '进入休息时会从下面列表随机推荐一项，提醒你离开座位动一动。可随意增删改。',
          ),
          BreakActivitiesEditor({ settings: state.settings, commit: commit }),
        ),
        h(
          'div',
          { className: 'dshp-card' },
          h('div', { className: 'dshp-cardTitle' }, '关于数据'),
          h('div', { className: 'dshp-note' }, '数据保存在本机：' + (state.storePath || '（未知）')),
          h(
            'div',
            { className: 'dshp-note' },
            '按工作区之外的一份全局记录统一存储，因此跨会话、跨工作区都能看到同一份统计。',
          ),
        ),
      )
    }

    /** The standalone panel: header + tabs + the selected tab body. */
    function Panel(props) {
      var state = useStore(store)
      var [tab, setTab] = React.useState('timer')
      var [scopeKey, setScopeKey] = React.useState('today')

      React.useEffect(
        function () {
          void bootstrap()
        },
        [],
      )

      var tabs = [
        { id: 'timer', label: '计时' },
        { id: 'stats', label: '统计' },
        { id: 'records', label: '记录' },
        { id: 'settings', label: '设置' },
      ]

      var runningText =
        state.status === 'running'
          ? '进行中 · ' + clockText(state.remainingMs) + ' · ' + effectiveProject(state)
          : state.status === 'paused'
            ? '已暂停 · ' + clockText(state.remainingMs)
            : '待开始'

      return h(
        'div',
        { className: 'dshp-root' },
        h(
          'div',
          { className: 'dshp-head' },
          h('h2', { className: 'dshp-title' }, '番茄钟'),
          h('span', { className: 'dshp-sub' }, runningText),
          h('div', { className: 'dshp-spacer' }),
          state.loading ? h('span', { className: 'dshp-sub' }, '载入中…') : null,
        ),
        h(
          'div',
          { className: 'dshp-tabs' },
          tabs.map(function (entry) {
            return h(
              'button',
              {
                key: entry.id,
                className: 'dshp-tab' + (tab === entry.id ? ' on' : ''),
                type: 'button',
                onClick: function () {
                  setTab(entry.id)
                },
              },
              entry.label,
            )
          }),
        ),
        h(
          'div',
          { className: 'dshp-body' },
          tab === 'timer' ? h(TimerTab, null) : null,
          tab === 'stats'
            ? h(
                'div',
                null,
                h(
                  'div',
                  { className: 'dshp-chips', style: { marginBottom: '12px' } },
                  [
                    { id: 'today', label: '今日' },
                    { id: 'week', label: '本周' },
                    { id: 'month', label: '本月' },
                    { id: 'total', label: '累计' },
                  ].map(function (entry) {
                    return h(
                      'button',
                      {
                        key: entry.id,
                        className: 'dshp-chip' + (scopeKey === entry.id ? ' on' : ''),
                        type: 'button',
                        onClick: function () {
                          setScopeKey(entry.id)
                        },
                      },
                      entry.label,
                    )
                  }),
                ),
                h(ScopeSummary, { scopeKey: scopeKey }),
                h(StatsTab, { scopeKey: scopeKey }),
              )
            : null,
          tab === 'records' ? h(RecordsTab, null) : null,
          tab === 'settings' ? h(SettingsTab, null) : null,
        ),
      )
    }

    /** A one-line summary of the selected scope, above the charts. */
    function ScopeSummary(props) {
      var state = useStore(store)
      var stats = state.stats
      if (stats === null) return null
      var scope = stats.scope[props.scopeKey]
      var label = { today: '今日', week: '本周', month: '本月', total: '累计' }[props.scopeKey]
      return h(
        'div',
        { className: 'dshp-card' },
        h(
          'div',
          { className: 'dshp-note' },
          label +
            '：完成 ' +
            scope.completed +
            ' 个番茄 · 专注 ' +
            humanMinutes(scope.focusedMinutes) +
            ' · 中断 ' +
            scope.interruptions +
            ' 次（其中放弃 ' +
            scope.aborted +
            '）· 跳过 ' +
            scope.skipped +
            ' 次 · 完成率 ' +
            scope.completionRate +
            '%',
        ),
      )
    }

    /**
     * Settle a run whose deadline passed while the page was closed.
     *
     * The pomodoro really did run to its end; the page simply was not there to
     * observe the boundary. Deferring this until after settings load is
     * deliberate: the record needs the configured `recordBreaks`/project
     * defaults, which are not known while the mirror is being read.
     */
    async function settleExpiredRun(expired) {
      var state = store.get()
      var isFocus = expired.phase === 'focus'
      var completedFocus = isFocus ? state.cycleFocusCount + 1 : state.cycleFocusCount
      var shouldRecord = isFocus || state.settings.recordBreaks === true

      if (shouldRecord) {
        var name = expired.project && expired.project.name ? expired.project.name : ''
        await persistRun({
          project: name !== '' ? name : state.settings.defaultProject,
          source: expired.project && expired.project.source ? expired.project.source : 'default',
          sessionId: expired.project && expired.project.sessionId ? expired.project.sessionId : '',
          phase: expired.phase,
          status: 'completed',
          startedAt: expired.startedAt > 0 ? expired.startedAt : expired.endedAt - expired.plannedMs,
          endedAt: expired.endedAt,
          plannedMs: expired.plannedMs,
          focusedMs: expired.plannedMs,
        })
      }

      store.set(
        Object.assign({}, store.get(), {
          cycleFocusCount: completedFocus,
          notice: (isFocus ? '专注完成' : '休息结束') + '（页面关闭期间到点，已自动记录）',
        }),
      )
      // The next phase starts automatically only when the user asked for it:
      // a run that ended off-screen must not silently begin a new commitment.
      enterPhase(nextPhaseAfter(expired.phase, completedFocus), { autoStart: shouldAutoStart(expired.phase) })
    }

    //#endregion

    //#region bootstrap

    var bootstrapped = false
    var ticker = null

    /** Load state once, restore any in-flight run, and start the ticker. */
    async function bootstrap() {
      if (bootstrapped) return
      bootstrapped = true
      insertStyles()

      var saved = loadActiveRun()
      /** A run that ran to completion while the page was closed. */
      var pendingExpiry = null
      if (saved !== null && typeof saved === 'object' && PHASE_ORDER.indexOf(saved.phase) >= 0) {
        var planned = Number(saved.plannedMs) || 25 * 60_000
        var remaining = Number(saved.remainingMs)
        if (!Number.isFinite(remaining) || remaining <= 0) remaining = planned
        var restored = {
          phase: saved.phase,
          plannedMs: planned,
          remainingMs: remaining,
          focusedMs: Number(saved.focusedMs) || 0,
          cycleFocusCount: Number(saved.cycleFocusCount) || 0,
          runStartedAt: Number(saved.runStartedAt) || 0,
          project:
            saved.project !== null && typeof saved.project === 'object'
              ? {
                  name: typeof saved.project.name === 'string' ? saved.project.name : '',
                  source: typeof saved.project.source === 'string' ? saved.project.source : 'default',
                  sessionId: typeof saved.project.sessionId === 'string' ? saved.project.sessionId : '',
                }
              : store.get().project,
          status: 'idle',
          deadline: 0,
        }
        if (saved.status === 'running' && Number(saved.deadline) > Date.now()) {
          restored.status = 'running'
          restored.deadline = Number(saved.deadline)
          restored.remainingMs = restored.deadline - Date.now()
        } else if (saved.status === 'running') {
          // The deadline passed while the page was closed: the run finished.
          // Hand it to `settleExpiredRun` once settings are available, instead
          // of dropping an earned pomodoro on the floor.
          restored.status = 'idle'
          restored.remainingMs = planned
          restored.focusedMs = 0
          pendingExpiry = {
            phase: saved.phase,
            plannedMs: planned,
            startedAt: Number(saved.runStartedAt) || 0,
            endedAt: Number(saved.deadline) || Date.now(),
            project: restored.project,
          }
        }
        store.set(Object.assign({}, store.get(), restored))
      }

      var result = await api.state()
      if (result && result.ok === true) {
        applyState(result.value)
        var state = store.get()
        // Adopt the default project on first start so the dial is never blank.
        if ((!state.project || state.project.name === '') && state.activeSessionId === '') {
          store.set(Object.assign({}, store.get(), { project: { name: '', source: 'default', sessionId: '' } }))
        }
      } else {
        store.set(
          Object.assign({}, store.get(), {
            loading: false,
            error: '无法读取番茄钟数据：' + describeError(result),
          }),
        )
      }

      // Settle a run that expired while the page was closed. Runs after
      // `applyState` so the record uses the real settings and project default.
      if (pendingExpiry !== null) await settleExpiredRun(pendingExpiry)

      void refreshSuggestion()
      if (ticker === null) ticker = startTicker()
    }

    //#endregion

    //#region plugin

    var inject = ['slots']

    function apply(ctx) {
      insertStyles()

      // 1) Sidebar entry. Its id doubles as the `main` key the rail selects,
      //    which is how ui-layout ties a panel row to its central occupant.
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_KEY,
            order: 20,
            label: function () {
              return '番茄钟'
            },
          },
          Glyph,
        )
      })

      // 2) The standalone panel itself.
      ctx.slots.inject('main', function () {
        return ctx.slots.register(
          {
            name: 'main',
            key: PANEL_KEY,
          },
          Panel,
        )
      })

      // 3) Session probe: remembers which Session is on screen so the project
      //    picker can resolve "the task I am on right now".
      ctx.slots.inject('conversation.input.dock', function () {
        return ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'dsh-pomodoro-session-probe',
            order: 90,
            inject: function (sessionId) {
              return { sessionId: typeof sessionId === 'string' ? sessionId : '' }
            },
          },
          SessionProbe,
        )
      })

      // 4) Phase-end card and the interruption prompt. Both live in the
      //    frame-wide floating layer so they are visible from any panel, not
      //    only while the pomodoro panel happens to be open.
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'dsh-pomodoro-overlay',
            order: 50,
          },
          function Overlay() {
            return h(React.Fragment, null, h(CompletionCard, null), h(FloatingTimer, null), h(ReasonPrompt, null))
          },
        )
      })

      // 5) Status-bar timer. `order: -10` places it BEFORE the shipped session
      //    statistics (ui-chat registers that one at order 0), and before
      //    cost-meter's statistics entry at order 1.
      ctx.slots.inject('conversation.composer.dock', function () {
        return ctx.slots.register(
          {
            name: 'conversation.composer.dock',
            id: 'dsh-pomodoro-dock',
            order: -10,
          },
          StatusBarTimer,
        )
      })

      // Teardown: stop the ticker and mark the fiber disposed, so any async
      // work still in flight (a settings save, a suggestion refresh, the
      // bootstrap chain) stops instead of writing into a bundle that a hot
      // reload has already replaced.
      ctx.effect(function () {
        return function () {
          disposed = true
          if (ticker !== null) {
            clearInterval(ticker)
            ticker = null
          }
        }
      }, 'dsh-pomodoro: stop ticker and bridge')
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})

// [end of dsh-pomodoro client bundle]
