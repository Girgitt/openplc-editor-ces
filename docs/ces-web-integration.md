# CES web integration mode

CES-specific development lives on the `ces-web` branch. Keep `main` synchronized with `Autonomy-Logic/openplc-editor/main`; merge/rebase upstream changes from `main` into `ces-web` explicitly.

Bootstrap the branch from the pinned upstream-synchronized commit:

```sh
git switch -c ces-web 37cdb6add403d99791071bdac0e9ba3784015a6a
```

Do not commit CES-specific changes to `main`.

## Purpose

`EDITOR-WEB-S1` runs the existing OpenPLC Editor renderer as a separately hosted localhost web application. CES remains a separate process and talks to the editor only through coarse REST resources. The editor does not import CES source or know about CES database/runtime implementation details.

Start after building the renderer:

```sh
npm run build:ces-web
npm run serve:ces-web -- --host 127.0.0.1 --port 43821 --session-token '<random token>'
```

The iframe URL may carry the token in its fragment so the browser-side bridge can authenticate API requests without sending it in the initial HTTP request:

```text
http://127.0.0.1:43821/#token=<random token>
```

`--project /server/path` is an optional trusted process-start argument. There is deliberately no REST endpoint that accepts arbitrary filesystem paths.

## REST boundary

### Health

`GET /api/health`

### Document

- `POST /api/document/load`
- `GET /api/document`
- `GET /api/document/raw` (renderer bridge projection)
- `POST /api/document/save`
- `POST /api/document/save-file`

Supported load envelopes:

```json
{"format":"plcopen-xml","documentId":"main","content":"<project>...</project>"}
```

or the native OpenPLC project-file envelope used by `ProjectPort.WriteProjectFiles`.

A full save returns the current serialized modified document. Loading PLCopen XML uses the editor's existing pending-import parser; after the first normal project save the canonical returned representation is the OpenPLC native project-file envelope. PLCopen re-export can be added as a later document-format operation without changing the process boundary.

### CES external symbols

- `PUT /api/context/symbols`
- `GET /api/context/symbols?q=&type=&direction=`

A symbol is intentionally coarse:

```json
{
  "id": "signal:7f83",
  "name": "P101_StartFeedback",
  "displayName": "Pump P101 / Start Feedback",
  "type": "BOOL",
  "direction": "input",
  "group": "PLC-01 / Local IO",
  "binding": "CES_P101_START_FB"
}
```

`id` is the stable CES identity used for live snapshots. `binding` is the editor-side token stored in `PLCVariable.location`. PLC variable names remain independent from CES signal names. The editor never receives the CES object graph.

The local and resource-global variable location selectors append type-filtered CES symbols. CES bindings are not reported as orphaned aliases while their symbol context is present.

### Read-only preview/live state

- `POST /api/live/snapshot`
- `GET /api/live/snapshot`
- `POST /api/live/clear`

Example:

```json
{
  "revision": 42,
  "values": [
    {"id":"signal:7f83","value":true,"quality":"good"}
  ]
}
```

The browser resolves the stable symbol ID to its current binding and maps the value onto PLC variables using existing OpenPLC debugger visualization. No runtime URL, credentials, forcing or write operation exists in the CES REST contract.

## Deliberately deferred

- CES subprocess/session manager and reverse proxy/iframe workspace integration;
- compiler/toolchain/Arduino library provisioning or offline caches;
- direct OpenPLC runtime communication from the editor;
- force/write/control operations;
- scalable server-side symbol discovery for very large catalogs;
- PLCopen XML save-back as the canonical save representation;
- build/deploy integration.
