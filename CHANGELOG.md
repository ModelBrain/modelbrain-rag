# Changelog

## 0.1.0 (preview)

First release.

- HTTP API on 127.0.0.1 for searching documents through an installed ModelBrain.
- Collections: one documents folder, one subfolder per collection; add and remove documents over HTTP.
- Vaults and partitions: an admin can share any vault or partition ModelBrain holds, search-only.
- API keys and web page users with read, write and admin access, and optional limit lists.
- Web page for search, documents, sharing, users, keys and settings, with a link to the documentation.
- A search result from a collection links to the whole document.
- Run in the background and start at sign-in on macOS and Linux; first-run setup in the page.
- macOS installer build script (Apple Silicon).

Known limits: every search runs ModelBrain's full ranking and takes most of a second. Not yet tested on Windows. No Windows installer.
