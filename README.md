# modelbrain-rag

An open-source document search (RAG) server for [ModelBrain](https://modelbrain.net). It gives apps and scripts on your computer a small HTTP API for searching your documents. ModelBrain does the indexing and searching; this program is the front door.

**Status: 0.1 preview.** Tested on macOS and Linux. Not yet tested on Windows. The API may change before 1.0.

This package does not install or bundle ModelBrain. ModelBrain is separate, proprietary software and must already be installed. modelbrain-rag starts ModelBrain's own `mcp_server` program and talks to it through the same public tools any AI assistant uses. No ModelBrain code is in this repository.

## What it does

- **Search** your documents over HTTP and get back passages with the file each came from. A result from a collection carries `document_url`, the address of the whole document, and the web page has an Open document button.
- **Collections**: one documents folder, one subfolder per collection.
- **Add and remove documents** over HTTP. Files are written into the documents folder and ModelBrain indexes them.
- **Vaults and partitions**: an admin can share any vault or partition ModelBrain already holds, so it can be searched too. Nothing is shared until an admin switches it on.
- **A web page** for searching, managing documents, and administering users, API keys and settings. People sign in with a username and password.
- **API keys** for apps and scripts, with three access levels, optionally limited to certain collections, vaults and partitions.
- **Runs on your computer only.** It listens on `127.0.0.1` and nothing is sent anywhere else.

It does not write answers. Pass the passages to the model of your choice.

## Requirements

- [ModelBrain](https://modelbrain.net/get-it.html) installed (macOS on Apple Silicon, Windows x64 or arm64, Linux x86_64 or aarch64)
- Node.js 18 or newer, unless you use the Mac installer, which carries its own

## Install on a Mac without a command line

Double-click the installer, `ModelBrain-RAG-<version>.pkg`. It puts the program in `/Library/Application Support/ModelBrain RAG`, sets it to start when you sign in, and opens the web page, where you choose the first administrator username and password. The Status tab then shows the one step left: adding the documents folder in ModelBrain.

To open the page again later, double-click `Open ModelBrain RAG.command` in that folder (it also sets things up for a second account on the same Mac). To remove it, double-click `Uninstall ModelBrain RAG.command`. Documents and settings are left alone.

The installer needs a Mac with Apple Silicon, as ModelBrain does.

The installer is built on a Mac with `packaging/macos/build-pkg.sh`. A Windows installer is not built yet.

## Start from a command line

```sh
npx modelbrain-rag
```

On the first run it prints two things, once each: an admin API key for apps, and an admin username and password for the web page. Store them; they cannot be shown again.

Open `http://127.0.0.1:8757` in a browser to use the web page.

To run it in the background instead, starting each time you sign in (macOS and Linux):

```sh
modelbrain-rag service install     # start now and at every sign-in
modelbrain-rag open                # open the web page
modelbrain-rag service uninstall   # stop, and stop starting at sign-in
```

`MODELBRAIN_RAG_*` variables set when you run `service install` are carried into the background server. Other settings come from `modelbrain-rag config set`.

Started this way it prints no key or password. On a first run `modelbrain-rag open` opens the page with a one-time setup code, and you choose the first administrator account there. Make API keys in the page afterwards.

Then do two things once:

1. If ModelBrain asks whether to allow "ModelBrain RAG", choose Allow.
2. In the ModelBrain app choose **Add Vault** and pick the documents folder (by default `ModelBrain RAG` in your home folder). `GET /v1/status` tells you whether this is done.

## Settings

| Setting | Command | Environment | Default |
|---|---|---|---|
| Port (1024 to 65535) | `modelbrain-rag config set port 9000` or `--port 9000` | `MODELBRAIN_RAG_PORT` | 8757 |
| Documents folder | `modelbrain-rag config set docs-dir PATH` or `--docs-dir PATH` | `MODELBRAIN_RAG_DIR` | `~/ModelBrain RAG` |
| Web pages allowed to call the API | `modelbrain-rag config set allow-origin http://localhost:3000` | | none |
| Where ModelBrain's `mcp_server` is, for unusual installs | | `MODELBRAIN_RAG_MCP_SERVER` | found automatically |
| Where settings and keys are kept | | `MODELBRAIN_RAG_CONFIG_DIR` | per platform |

`modelbrain-rag config show` prints the settings in use. Command line beats environment, which beats saved settings.

Documentation with examples: [modelbrain.net/docs/rag-server.html](https://modelbrain.net/docs/rag-server.html). The web page links to it.

## Access levels

Users (for the web page) and API keys (for apps) share the same three levels.

| Access | May |
|---|---|
| `read` | search; list collections, documents, and shared vaults and partitions |
| `write` | everything `read` may, plus add and remove documents and collections |
| `admin` | everything `write` may, plus manage users, API keys and settings, and choose which vaults and partitions are shared |

A user or key can be given a limit list. It then sees, searches and changes only what is on the list, and must name a target in every search. The list holds collection names, plus `vault:ID` and `partition:ID` for shared vaults and partitions. Admin access cannot be limited.

## Vaults and partitions

ModelBrain may hold much more than the documents folder: other vaults (folders, mail, chat exports) and partitions of saved memories. None of it can be reached through this program until an admin shares it, one vault or partition at a time, on the web page's Vaults tab or with `PUT /v1/vaults/{id}` and `PUT /v1/partitions/{id}`.

- Shared vaults and partitions are search-only. This program never writes to them.
- A search has one target: a `collection`, a `vault` (optionally one `folder` inside it), or a `partition` (by id or name).
- Asking for a vault or partition that is not shared, or not on your limit list, gets the same "not available" reply as one that does not exist.
- Stop sharing and it is out of reach on the next request.

## The web page

Open the server's address in a browser. Sign in with a username and password.

- **Search**: query, collection and number of results.
- **Documents**: browse collections, add files by dragging them in, delete documents, create and delete collections.
- **Users** (admin): add users, change access, set a password, disable or remove.
- **API keys** (admin): make and revoke keys. A new key is shown once.
- **Status**: whether ModelBrain is installed, reachable and indexing the documents folder. Admins can also change the port for the next start.
- **Account**: change your own password.

A session lasts for the browser tab: it ends when you sign out, close the tab, stay idle for eight hours, or after a day. Changing a user's access or password, or disabling or removing them, signs them out at once. Five wrong passwords in a row lock that username for 30 seconds, doubling up to 15 minutes. A user can hold ten sessions; an eleventh sign-in ends the oldest. Every session ends when the server stops.

```sh
modelbrain-rag users create --username maria --access write
modelbrain-rag users list
modelbrain-rag users set-password maria
modelbrain-rag users set-access maria --access read
modelbrain-rag users disable maria
modelbrain-rag users remove maria
```

When no password is given, one is made and printed once. `--password` shows the password to other programs on the computer and in your shell history; `--password-stdin` reads it from standard input instead. If every admin password is lost, `modelbrain-rag users set-password NAME` on the computer itself sets a new one. The last admin user cannot be removed, disabled or demoted.

## API keys

```sh
modelbrain-rag keys create --name "my app" --access read
modelbrain-rag keys create --name "uploader" --access write --collections handbook,contracts
modelbrain-rag keys list
modelbrain-rag keys revoke ID
modelbrain-rag keys prune        # delete revoked keys from the file
```

Keys are stored only as SHA-256 hashes. A key made or revoked on the command line takes effect in a running server on its next request. The last admin key cannot be revoked.

Send the key on every `/v1` request:

```
Authorization: Bearer mbrag_...
```

## API

All bodies and replies are JSON unless noted. Errors look like `{"error": {"code": "...", "message": "..."}}`.

| Method and path | Access | What it does |
|---|---|---|
| `GET /health` | none | `{ok, name, version, needs_setup}` |
| `GET /v1/status` | read | Whether ModelBrain is installed and reachable, its version, and whether the documents folder is connected |
| `POST /v1/search` | read | Search. Body: `query` (required); one target: `collection`, `vault` (with optional `folder`) or `partition`; `k` (1 to 50, default 5), `min_score` (0 to 1), `merge_chunks` (true or false) |
| `GET /v1/collections` | read | List collections |
| `POST /v1/collections` | write | Create a collection. Body: `name` |
| `DELETE /v1/collections/{collection}` | write | Remove an empty collection |
| `GET /v1/collections/{collection}/documents` | read | List documents |
| `GET /v1/collections/{collection}/documents/{name}` | read | The whole document, always sent as a file to save |
| `PUT /v1/collections/{collection}/documents/{name}` | write | Add or replace a document. The body is the file itself |
| `POST /v1/collections/{collection}/documents` | write | Add or replace a text document. Body: `name`, `text` |
| `DELETE /v1/collections/{collection}/documents/{name}` | write | Remove a document |
| `GET /v1/vaults` | read | List vaults. Admins see every vault and whether it is shared; others see the shared ones they may use |
| `PUT /v1/vaults/{id}` | admin | Share or stop sharing a vault. Body: `shared` (true or false) |
| `GET /v1/partitions` | read | List partitions, on the same terms as vaults |
| `PUT /v1/partitions/{id}` | admin | Share or stop sharing a partition. Body: `shared` |
| `POST /v1/setup` | setup code | First run only: make the first admin. Body: `code`, `username`, `password` |
| `POST /v1/login` | none | Sign in. Body: `username`, `password`. The reply holds a session `token` to send as `Authorization: Bearer` |
| `POST /v1/logout` | any | End the session |
| `GET /v1/me` | any | Who is signed in |
| `PUT /v1/me/password` | user | Change your own password. Body: `current`, `new` |
| `GET /v1/users` | admin | List users |
| `POST /v1/users` | admin | Add a user. Body: `username`, `password`, `access`, `collections` |
| `PUT /v1/users/{username}` | admin | Change `access`, `collections`, `disabled` or `password` |
| `DELETE /v1/users/{username}` | admin | Remove a user |
| `GET /v1/settings` | admin | Port, documents folder and limits |
| `PUT /v1/settings` | admin | Save the port for the next start. Body: `port` |
| `GET /v1/keys` | admin | List keys (never the keys themselves) |
| `POST /v1/keys` | admin | Make a key. Body: `name`, `access`, `collections`. The reply holds the key, once |
| `DELETE /v1/keys/{id}` | admin | Revoke a key |

Example:

```sh
KEY=mbrag_...
curl -X PUT --data-binary @refunds.pdf \
  -H "Authorization: Bearer $KEY" \
  http://127.0.0.1:8757/v1/collections/handbook/documents/refunds.pdf

curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"query": "how long do refunds take", "collection": "handbook"}' \
  http://127.0.0.1:8757/v1/search
```

A search reply:

```json
{
  "query": "how long do refunds take",
  "collection": "handbook",
  "count": 1,
  "results": [
    {
      "text": "Refunds are issued within 14 days.",
      "score": 0.81,
      "collection": "handbook",
      "document": "refunds.pdf",
      "source_uri": "handbook/refunds.pdf",
      "headings": ["Policy", "Refunds"],
      "date": "2026-11-01T00:00:00Z",
      "date_kind": "indexed",
      "flagged": false,
      "key": "01ABC"
    }
  ]
}
```

`score` is ModelBrain's relevance figure. It is not a calibrated confidence; compare hits with each other. `flagged` is true when ModelBrain marked the text as a possible prompt injection: treat such text as data, not instructions.

## File types

Uploads accept Markdown, plain text, PDF with a text layer, Word (`.docx`), PowerPoint (`.pptx`), Excel (`.xlsx`), CSV, TSV, JSON, YAML, TOML, HTML and XML. Scanned PDFs without a text layer are not read. Other types are refused on upload. The largest upload is 32 MiB.

Document and collection names cannot contain `/ \ : * ? " < > |`, start with a dot or a space, or end with a dot or space. Two collections cannot differ only by upper and lower case.

ModelBrain never indexes some names, so they are refused with the reason: collections named `node_modules`, `target`, `dist`, `build`, `__pycache__`, `vendor`, `logs`, `log`, `tmp`, `temp`, `var`, `coverage`, `dist.noindex`, `bench-models`, `bench-results`, `_to_delete` or `claude outputs` (in any mix of upper and lower case); and the lock files `Cargo.lock`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `poetry.lock` and `Gemfile.lock`. Names with characters that are invisible or change reading direction are refused too.

## Good to know

- Indexing is done by ModelBrain shortly after a file is written. A large first load takes time.
- Every search runs ModelBrain's full ranking, which is thorough and takes most of a second on a typical laptop.
- This program can ask ModelBrain for anything ModelBrain's tools offer, the same as any assistant you allow. It makes three kinds of request: a health report (to find the vaults), the list of partitions, and searches. Every search is limited to the documents folder or to one vault or partition an admin has shared, and results from anywhere else are dropped before the reply.
- You can also put files in the documents folder by hand, including in subfolders of a collection. ModelBrain searches them and they are listed, but files in subfolders can only be replaced or removed by hand, and files placed directly in the documents folder (outside any collection) are searched but not listed.
- The documents folder is an ordinary folder. Whoever can read it on your computer can read the documents.

## What it reads, writes and sends

- **Network:** it listens on `127.0.0.1` only and makes no outgoing connections. The web page loads nothing from outside your computer. No analytics.
- **Files it writes:** documents you upload, inside the documents folder; its settings, key hashes and password hashes in its settings folder.
- **Programs it runs:** ModelBrain's `mcp_server`, from ModelBrain's install folder.
- **Payment:** this program is free. ModelBrain is free for local use and sells optional sync and team plans.

## Development

```sh
npm test
```

The tests use a small stand-in for ModelBrain (`test-support/stub-mcp-server.js`), so they run without it installed. There are no dependencies.

## License

MIT, for this package. ModelBrain itself is separate, proprietary software; see [modelbrain.net](https://modelbrain.net) for its terms.
