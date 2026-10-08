# M5-3 editor simulation E2E (opt-in)

This is a **separate acceptance suite**. It is not imported by normal editor Jest,
`test:ces-web-server`, regular Playwright, the CES `verify-all.sh` scripts, or
`openplc-editor-publish-patch.sh`. Each scenario calls the **real** STruC++ /
Arduino CLI compiler, then the browser's AVR8js simulator and debugger.
Compilation takes 30+ seconds and can initially download Arduino dependencies.

## Run

From the CES root (after publishing/pinning this change):

```bash
./scripts/e2e-openplc-simulation.sh
# Or one case:
./scripts/e2e-openplc-simulation.sh --case M53_FBD_RS
```

Or from this editor repository:

```bash
npm ci                        # if dependencies are missing
npm run build:ces-web         # if the bundle is missing or stale
./scripts/test-ces-simulation-e2e.sh
```

Prerequisites: Chromium installed for Playwright (`npx playwright install
chromium`), Electron's local CLI, STruC++, Arduino CLI, and the CES web build.
The suite does NOT use a fake compiler or silently skip missing prerequisites.
The compiler must have network access or warmed Arduino package cache for
first-time installation.

`CES_SIM_E2E_TIMEOUT_MS` controls the real-build timeout (default 240000 ms).
`CES_SIM_E2E_HEADED=1` shows the browser. `CES_SIM_E2E_ARTIFACTS` overrides the
artifact directory; by default artifacts are under
`test-results/ces-simulation-e2e/` in this editor repository. An isolated
project and web server are created for each case. Tests are serial; they do not
edit the operator's CES projects or contact physical PLCs.

## Acceptance scenarios

- **M53_FBD_RS:** save, close/reload editor, verify `S`/`R1` edge identities,
  compile, start, observe debug values, force `v1` to set `RS0`, release and
  verify latch, force `v2` to reset, stop, then compile/start/stop again.
- **M53_LD_AND:** save/reload ladder contacts and connections, compile/start,
  force `v1` (with `v2` TRUE), verify coil output, release and verify FALSE.
- **M53_LD_OR:** parallel branch, compile/start, force `v1`, verify coil output,
  release and verify FALSE.
- **M53_ST_TON:** compile/start ST timer with `T#100ms` preset, verify
  debug snapshot and output transitions TRUE, then stop.

A PASS requires **live** simulator debug snapshot values. Merely producing
`firmware.hex` is insufficient. Source POU fixtures are generated in temporary
standalone OpenPLC projects; no CES System Tag bindings are needed.

Failures save a screenshot, Playwright trace, video and JSON diagnostics.
`summary.json` is written for CI integration. The script returns a nonzero exit
code if *any* case fails, including missing dependencies.

These are real integration checks, so initial execution should be reviewed and
selectors adjusted if the user-facing editor changes. They are NOT validated
merely by successfully running the mocked server contract test.
