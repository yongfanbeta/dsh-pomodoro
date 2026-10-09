# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-09

First public release.

### Added

- **Classic pomodoro timer** — 25 / 5 / 15 focus / short-break / long-break cycles, all durations and the long-break cadence configurable. Deadline-based countdown (no drift), auto-corrects after background tab throttling.
- **Task / project association** — resolves the current session's workspace and title as one-click candidates, plus recent projects, manual entry, and a configurable default project name.
- **Standalone full-screen panel** with four tabs: Timer, Statistics, Records, Settings.
- **Year heatmap** (last 365 days, GitHub-contribution-style, theme-aware greens, dense grid, hover tooltips, future days drawn as hollow cells).
- **Status-bar pill** in the composer dock showing the live countdown, click-to-expand details, reduced-motion aware.
- **Completion cards** via `shell.overlay` — focus-end auto-starts the next break; break-end notifies but does not auto-start the next focus by default.
- **Interruption accounting** — `completed` / `interrupted` / `aborted` / `skipped` are tracked separately so the completion rate stays trustworthy; an interrupted pomodoro can be resumed and still counts as one completion. Interruption reasons are prompt-selectable and appear in the records table and CSV.
- **Local persistence + CSV export** — atomic, serialized JSON store with corrupt-file quarantine; UTF-8-BOM / CRLF / RFC-4180 CSV that opens correctly in Excel.
- **Installers** — `scripts/install.ps1` (Windows) and `scripts/install.sh` (macOS / Linux), both auto-detecting the running profile and registering bundle + dependency.
- **Verification scripts** — `check:install` (loader-contract + byte-for-byte source consistency) and `check:cordis` (mounts the host half under real Cordis).
- **Test suite** — 105 tests across four layers (core / store / host / client), the client layer actually evaluating and mounting the prebuilt client bundle through a mini-React harness.
- **CI** — GitHub Actions matrix (Ubuntu / Windows / macOS × Node 20 / 22) plus a package-sanity job.

### Known limitations

- Prompt sounds need a prior user interaction (browser autoplay policy); system notifications need permission and fail silently otherwise.
- Session titles come from the host `sessionTitle` service; degrades to workspace/dir name when unavailable.
- Data is a single global log, not isolated per workspace (intentional tradeoff).
- Export is CSV, not multi-sheet `.xlsx`.

[Unreleased]: https://github.com/yongfanbeta/dsh-pomodoro/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/yongfanbeta/dsh-pomodoro/releases/tag/v0.1.0
