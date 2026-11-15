# Security

## Reporting a problem

Email security@modelbrain.net. Please do not open a public issue for a security problem.

## How modelbrain-rag is protected

- It listens on `127.0.0.1` only. Other computers cannot reach it.
- Every `/v1` route except sign-in needs an API key or a signed-in session.
- API keys are random, shown once, and stored only as SHA-256 hashes.
- Passwords are stored only as scrypt hashes with a per-user salt. Five wrong passwords in a row lock that username for 30 seconds, doubling up to 15 minutes. The check takes the same time whether or not the username exists. Guesses for one username are checked one at a time, so guessing in parallel gains nothing, and at most 16 password checks run at once. Wrong guesses on the change-password form are counted apart from sign-in.
- Sessions are random tokens held in the server's memory and in the browser tab (sessionStorage), sent as an `Authorization` header. No cookies are used, so another site cannot ride on a session and another program on a different port of this computer is not sent it. Sessions end after eight idle hours, after a day, and when the user's access or password changes or the user is removed. A session belongs to one account, not to a username, so it does not pass to a new user given an old name. Access is checked again after a request's body has arrived, so a change made in the meantime applies.
- The key and user files are written with owner-only permissions on macOS and Linux. On Windows they rely on your user profile's permissions.
- Requests whose `Host` is not `127.0.0.1`, `localhost` or `[::1]` on the server's own port are refused, which blocks DNS rebinding from a web page.
- Requests that carry a browser `Origin` other than the server's own page are refused unless that origin was allowed in settings.
- The page has one link that leaves your computer, to the documentation on modelbrain.net. It opens only when clicked and sends no referrer. The web page is served with a content security policy that allows only its own script and styles, forbids framing, and lets it talk only to this server. It adds everything it shows as text, so the contents of a document cannot run as script.
- Collection and document names are checked so a request cannot read, write or delete outside the documents folder. Links found in the documents folder are refused for writes and deletes, and checked again just before each write.
- Vaults and partitions held by ModelBrain cannot be reached until an admin shares each one. Shared ones are search-only. Results that did not come from the place asked for are dropped. A vault or partition that is not shared, or not on the caller's limit list, answers the same as one that does not exist.
- First-run setup from the installer uses a one-time code of 256 random bits, written to a file only your user can read and removed once the first admin exists. It reaches the page in the address fragment, which a browser never sends to a server, and the page removes it from the address bar (the browser may still keep the address in its history; the code is dead once used). `modelbrain-rag open` sends the code only to a server that proves it wrote the code file, and hands the browser a private file instead of an address so the code does not show in the list of running programs. The code works once. After twenty wrong codes it is replaced by a new one. It is written only after the server has its port, removed when the server stops, and never offered once an admin exists. A web page from another site cannot use it or wear it out; an origin you added to the allowed list can call setup like any other route.
- A whole document is always sent as a file to save, with a plain binary type, so an HTML document cannot run as a page of this server. The web page shows text documents as plain text.
- Uploads are written to a hidden temp folder and renamed into place.
- It has no dependencies beyond Node.js.

## What it does not protect against

- Another program running as you on the same computer can read and change the documents folder directly, could read a key from wherever you store it, and could win a race against the link checks above.
- The connection is plain HTTP on this computer. Do not put it behind a tunnel or proxy to other computers without adding TLS and thinking again about who can reach it.
- ModelBrain decides which programs may use it. Allowing "ModelBrain RAG" gives this program the same access to ModelBrain as any assistant you allow.
- The local ModelBrain store is not encrypted by ModelBrain; it relies on your operating system's protection.
- Someone who can reach the server (which means a program on this computer) and knows a username can keep that username locked by sending wrong passwords. API keys are not affected, and `modelbrain-rag users set-password NAME` on the computer still works.
- Sharing a vault or partition lets every user and key without a limit list search all of it. Mail, contacts and chat vaults and partitions of saved memories can hold private material; share them with that in mind and use limit lists.
- A password given with `--password` is visible to other programs on the computer and stays in shell history. Use `--password-stdin`.
- Started from a terminal, the first-run key and password are printed there. Started in the background (`--service`), nothing is printed and setup happens in the page.
- Until the first admin is made, another program running as you could read the setup code and make that account first. Finish setup straight after installing.
- The Mac installer includes Node.js as published by the Node.js project. The build script pins the SHA-256 of that download; it does not check the project's release signature itself.
- On a Mac with several accounts, each account's server wants the same port. Only the first to start gets it; give the others their own with `modelbrain-rag config set port N`. `open` refuses to send a setup code to a server that is not that account's own.
