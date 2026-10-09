# Security Policy

## Data handling

This plugin stores everything **locally**. There is no telemetry, no analytics,
and no network calls to any third party.

- Pomodoro records and settings are written to
  `${DSH_HOME:-~/.dsh}/storages/pomodoro/state.json`.
- The plugin registers only DSH-relative HTTP routes under
  `/api/dsh-pomodoro/*` (see the README architecture table). These are served
  by the DSH host process and are not reachable from the public internet.
- CSV export happens entirely client-side; nothing is uploaded.

## Reporting a vulnerability

If you find a security issue, please open a **private security advisory** on
GitHub rather than a public issue:

<https://github.com/yongfanbeta/dsh-pomodoro/security/advisories/new>

Include reproduction steps and, if relevant, which DSH version and surface
(desktop / `dsh web`) you tested on.
