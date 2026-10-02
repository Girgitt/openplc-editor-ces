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

## EDITOR-WEB-S1H standalone project lifecycle

`EDITOR-WEB-S1H` hardens the separately hosted web editor so it is useful both as a REST-driven CES editor process and as a self-contained standalone OpenPLC web editor.

### Standalone project root

Start the server with an existing project storage root:

```sh
npm run serve:ces-web -- \
  --host 127.0.0.1 \
  --port 43821 \
  --session-token '<random token>' \
  --project-root /srv/openplc/projects \
  --initialize-new-project=false
```

Then a browser URL may select a project directly below that root:

```text
http://127.0.0.1:43821/?project_id=pump-test#token=<random token>
```

`project_id` is a standalone OpenPLC project identifier, not a CES project/PLC Program ID. It must be a single safe directory name. Nested paths, absolute paths and traversal forms are rejected.

The `#token=` fragment remains intentional: URL fragments are not sent in the initial HTTP request. The browser captures the token into `sessionStorage`, removes it from the visible URL, and only then performs authenticated API calls. `?project_id=` therefore never causes an unauthenticated filesystem operation. Browser bootstrap translates it into:

```text
POST /api/project/open
X-CES-Editor-Token: <token>
{"projectId":"pump-test"}
```

The static `GET /?project_id=...` only serves the web application.

### Initialization rules

For `<project-root>/<project_id>`:

| State | `--initialize-new-project=false` | `--initialize-new-project=true` |
| --- | --- | --- |
| valid OpenPLC project | open | open |
| missing directory | reject | create + initialize + open |
| existing empty directory | initialize + open | initialize + open |
| non-empty directory without `project.json` | reject | reject |
| unsafe project ID | reject | reject |

`--project-root` itself must already exist; a misspelled or missing root is a startup error. `--project /trusted/path` follows the same missing/empty/non-empty initialization rules, but is a trusted process-start path rather than browser input.

A new standalone project uses the current OpenPLC defaults: PLC project metadata, one cyclic `task0`, one `main` program instance, simulator device defaults, pin mapping and a default `main.st` POU.

### Persistence ownership

Opening through `--project` or `POST /api/project/open` creates a filesystem-backed editor session. Normal editor saves write back into that OpenPLC project directory.

Loading through `POST /api/document/load` creates a REST-owned session. Normal editor saves update the serialized session document only; they do not write to a previously opened filesystem project. This keeps future CES persistence authoritative.

### REST initialization test helper

`scripts/ces-web-load-project.mjs` converts an existing native OpenPLC project directory into the normal `openplc-project-files` envelope and posts it through `/api/document/load`. It does not add a REST endpoint that accepts arbitrary filesystem paths.

The CES wrapper exposes this as `scripts/openplc-editor.sh --load-via-api <project-directory>` so the exact REST initialization path expected by CES can be exercised independently of `--project` / `?project_id=` standalone mode.
