'use strict';

// The web page. People sign in with a username and password. The server
// answers with a session token, which is kept for this browser tab only
// (sessionStorage) and is sent to this server and nowhere else. The page
// then uses the same /v1 API as any other client.
//
// Everything shown on the page is added as text, never as HTML, so the
// contents of a document cannot run as script here.

(function () {
  var root = document.getElementById('app');
  var KEY_SLOT = 'modelbrain-rag-session';
  var state = { key: null, me: null, tab: 'search', notice: null };

  try {
    state.key = sessionStorage.getItem(KEY_SLOT);
  } catch (e) {
    state.key = null;
  }

  // el('div', {class: 'x', onclick: fn}, child, 'text', [more])
  function el(tag, attrs) {
    var node = document.createElement(tag);
    var a = attrs || {};
    Object.keys(a).forEach(function (name) {
      var value = a[name];
      if (value === null || value === undefined || value === false) return;
      if (name.slice(0, 2) === 'on' && typeof value === 'function') node.addEventListener(name.slice(2), value);
      else if (name === 'class') node.className = value;
      else if (name === 'value') node.value = value;
      else if (value === true) node.setAttribute(name, '');
      else node.setAttribute(name, String(value));
    });
    for (var i = 2; i < arguments.length; i += 1) addOne(node, arguments[i]);
    return node;
  }

  // add(node, child, child, ...): text is always added as text, never HTML.
  function add(node) {
    for (var i = 1; i < arguments.length; i += 1) addOne(node, arguments[i]);
  }

  function addOne(node, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) child.forEach(function (c) { addOne(node, c); });
    else if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function ApiError(status, code, message) {
    this.status = status;
    this.code = code;
    this.message = message;
  }

  function api(method, path, options) {
    var opts = options || {};
    var headers = {};
    if (!opts.anonymous) headers.Authorization = 'Bearer ' + state.key;
    var init = { method: method, headers: headers, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' };
    if (opts.raw !== undefined) init.body = opts.raw;
    else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(path, init).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (e) {
          data = null;
        }
        if (!res.ok) {
          var err = (data && data.error) || {};
          if (res.status === 401 && !opts.anonymous && !opts.keepSession) signOut('You were signed out. Sign in again.', true);
          throw new ApiError(res.status, err.code || 'error', err.message || 'The request failed (' + res.status + ').');
        }
        return data;
      });
    }, function () {
      throw new ApiError(0, 'unreachable', 'The server did not answer. Is modelbrain-rag still running?');
    });
  }

  function seg(value) {
    return encodeURIComponent(value);
  }

  function signOut(message, alreadyEnded) {
    if (state.key && !alreadyEnded) {
      // Tell the server to end the session. The page signs out either way.
      fetch('/v1/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + state.key }, credentials: 'omit' }).catch(function () {});
    }
    try {
      sessionStorage.removeItem(KEY_SLOT);
    } catch (e) { /* nothing to remove */ }
    state.key = null;
    state.me = null;
    renderSignIn(message);
  }

  function message(kind, text) {
    return el('div', { class: 'msg ' + kind, role: kind === 'error' ? 'alert' : 'status' }, text);
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function fmtDate(iso) {
    if (!iso) return 'never';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
  }

  // A button that asks for a second click before it acts.
  function confirmButton(label, confirmLabel, action) {
    var armed = false;
    var timer = null;
    var button = el('button', { class: 'small danger', type: 'button' }, label);
    button.addEventListener('click', function () {
      if (!armed) {
        armed = true;
        button.textContent = confirmLabel;
        timer = setTimeout(function () {
          armed = false;
          button.textContent = label;
        }, 4000);
        return;
      }
      clearTimeout(timer);
      button.disabled = true;
      action(button);
    });
    return button;
  }

  // The one link that leaves this computer. It opens only when clicked, in
  // a new tab, and tells the site nothing about this page.
  var DOCS_URL = 'https://modelbrain.net/docs/rag-server.html';
  function docsLink(label) {
    return el('a', { class: 'doclink', href: DOCS_URL, target: '_blank', rel: 'noopener noreferrer' }, label || 'Documentation');
  }

  // ---------- sign in ----------

  function renderSignIn(note) {
    clear(root);
    var username = el('input', { type: 'text', autocomplete: 'username', spellcheck: 'false', autocapitalize: 'none', 'aria-label': 'Username', maxlength: 64 });
    var password = el('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Password', maxlength: 200 });
    var out = el('div');
    if (note) add(out, message('warn', note));
    var button = el('button', { class: 'primary', type: 'submit' }, 'Sign in');
    var form = el('form', {
      onsubmit: function (event) {
        event.preventDefault();
        if (!username.value.trim() || !password.value) return;
        clear(out);
        button.disabled = true;
        api('POST', '/v1/login', { anonymous: true, body: { username: username.value.trim(), password: password.value } }).then(function (session) {
          state.key = session.token;
          state.me = session.signed_in;
          try {
            sessionStorage.setItem(KEY_SLOT, session.token);
          } catch (e) { /* stays signed in until the page closes */ }
          return api('GET', '/v1/status').then(renderApp);
        }).then(null, function (err) {
          button.disabled = false;
          password.value = '';
          add(out, message('error', err.message));
        });
      },
    },
      el('div', { class: 'label' }, 'Username'),
      username,
      el('div', { class: 'label' }, 'Password'),
      password,
      button);
    add(root, el('div', { class: 'signin' },
      el('div', { class: 'brand' }, el('img', { src: '/ui/favicon.svg', alt: '' }), 'ModelBrain RAG'),
      el('p', { class: 'lede' }, 'Search your documents and manage access.'),
      el('div', { class: 'card' }, out, form),
      el('p', { class: 'lede' }, 'An administrator can add more users. ', docsLink())));
    username.focus();
  }

  // ---------- first-run setup ----------

  // Shown once, after an install, when no admin account exists yet. The
  // one-time code arrives in the address fragment and is removed from the
  // address bar straight away.
  function renderSetup(code) {
    clear(root);
    var out = el('div');
    var box = el('div', { class: 'signin' },
      el('div', { class: 'brand' }, el('img', { src: '/ui/favicon.svg', alt: '' }), 'ModelBrain RAG'),
      el('p', { class: 'lede' }, 'Welcome. Choose the first administrator account for this server.'));
    if (!code) {
      add(box, el('div', { class: 'card' }, message('warn', 'This server has no administrator yet. To set it up, close this tab and open ModelBrain RAG again: double-click "Open ModelBrain RAG" in its install folder, or run "modelbrain-rag open". That opens this page with a one-time setup code.')));
      add(root, box);
      return;
    }
    var username = el('input', { type: 'text', autocomplete: 'username', spellcheck: 'false', autocapitalize: 'none', 'aria-label': 'Choose a username', maxlength: 64, value: 'admin' });
    var password = el('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Choose a password', maxlength: 200 });
    var again = el('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Repeat the password', maxlength: 200 });
    var button = el('button', { class: 'primary', type: 'submit' }, 'Create account');
    var form = el('form', {
      onsubmit: function (event) {
        event.preventDefault();
        clear(out);
        if (!username.value.trim() || !password.value) return;
        if (password.value !== again.value) {
          add(out, message('error', 'The two passwords are not the same.'));
          return;
        }
        button.disabled = true;
        api('POST', '/v1/setup', { anonymous: true, body: { code: code, username: username.value.trim(), password: password.value } }).then(function (session) {
          state.key = session.token;
          state.me = session.signed_in;
          try {
            sessionStorage.setItem(KEY_SLOT, session.token);
          } catch (e) { /* stays signed in until the page closes */ }
          return api('GET', '/v1/status').then(function (status) {
            state.tab = 'status';
            renderApp(status);
          });
        }).then(null, function (err) {
          button.disabled = false;
          add(out, message('error', err.message));
        });
      },
    },
      el('div', { class: 'label' }, 'Username'), username,
      el('div', { class: 'label' }, 'Password (10 characters or more)'), password,
      el('div', { class: 'label' }, 'Password again'), again,
      button);
    add(box, el('div', { class: 'card' }, out, form),
      el('p', { class: 'lede' }, 'This account can add other users and make API keys for apps. ', docsLink()));
    add(root, box);
    password.focus();
  }

  function setupCode() {
    var match = /^#setup=([A-Za-z0-9_-]{43})$/.exec(location.hash || '');
    if (location.hash) {
      try {
        history.replaceState(null, '', location.pathname);
      } catch (e) { /* the address keeps its fragment */ }
    }
    return match ? match[1] : null;
  }

  // ---------- frame ----------

  var TABS = [
    { id: 'search', label: 'Search', access: 'read' },
    { id: 'documents', label: 'Documents', access: 'read' },
    { id: 'sources', label: 'Vaults', access: 'admin' },
    { id: 'users', label: 'Users', access: 'admin' },
    { id: 'keys', label: 'API keys', access: 'admin' },
    { id: 'status', label: 'Status', access: 'read' },
    { id: 'account', label: 'Account', access: 'read' },
  ];
  var RANK = { read: 0, write: 1, admin: 2 };

  function can(access) {
    return state.me && RANK[state.me.access] >= RANK[access];
  }

  var views = {};
  var body = null;

  function renderApp(status) {
    clear(root);
    var tabs = el('nav', { class: 'tabs', 'aria-label': 'Sections' });
    TABS.forEach(function (tab) {
      if (!can(tab.access)) return;
      add(tabs, el('button', {
        class: 'tab', type: 'button', 'data-tab': tab.id,
        onclick: function () { show(tab.id); },
      }, tab.label));
    });
    body = el('main');
    add(root, el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('img', { src: '/ui/favicon.svg', alt: '' }), 'ModelBrain RAG'),
      tabs,
      el('div', { class: 'who' },
        docsLink('Docs'),
        state.me.name + ' (' + state.me.access + ')',
        el('button', { class: 'small', type: 'button', onclick: function () { signOut(); } }, 'Sign out'))));
    add(root, body);
    state.status = status;
    show(status && (!status.modelbrain.reachable || !status.documents_folder.connected) ? 'status' : 'search');
  }

  function show(id) {
    state.tab = id;
    Array.prototype.forEach.call(root.querySelectorAll('.tab'), function (button) {
      if (button.getAttribute('data-tab') === id) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    clear(body);
    views[id](body);
  }

  var lastSkipped = [];
  function loadCollections() {
    return api('GET', '/v1/collections').then(function (data) {
      lastSkipped = data.skipped || [];
      return data.collections;
    });
  }

  // Shared vaults and partitions this person may search.
  function loadShared() {
    return Promise.all([
      api('GET', '/v1/vaults').then(function (d) { return d.vaults; }, function () { return []; }),
      api('GET', '/v1/partitions').then(function (d) { return d.partitions; }, function () { return []; }),
    ]).then(function (lists) {
      return {
        vaults: lists[0].filter(function (v) { return v.shared; }),
        partitions: lists[1].filter(function (p) { return p.shared; }),
      };
    });
  }

  // ---------- search ----------

  views.search = function (main) {
    var query = el('input', { type: 'text', class: 'grow', placeholder: 'What are you looking for?', 'aria-label': 'Search', maxlength: 2000 });
    var collection = el('select', { 'aria-label': 'Where to search' });
    var count = el('select', { 'aria-label': 'Number of results' });
    [5, 10, 20, 50].forEach(function (n) { add(count, el('option', { value: n }, n + ' results')); });
    var out = el('div');
    var limited = Boolean(state.me.collections);

    Promise.all([loadCollections().then(null, function (err) { add(out, message('error', err.message)); return []; }), loadShared()]).then(function (both) {
      var cols = both[0];
      var sharedSources = both[1];
      if (!limited) add(collection, el('option', { value: '' }, 'All collections'));
      if (cols.length) {
        var groupC = el('optgroup', { label: 'Collections' });
        cols.forEach(function (c) { add(groupC, el('option', { value: 'c:' + c.name }, c.name)); });
        add(collection, groupC);
      }
      if (sharedSources.vaults.length) {
        var groupV = el('optgroup', { label: 'Vaults' });
        sharedSources.vaults.forEach(function (v) { add(groupV, el('option', { value: 'v:' + v.id }, v.id)); });
        add(collection, groupV);
      }
      if (sharedSources.partitions.length) {
        var groupP = el('optgroup', { label: 'Partitions' });
        sharedSources.partitions.forEach(function (p) { add(groupP, el('option', { value: 'p:' + p.id }, p.name)); });
        add(collection, groupP);
      }
      if (cols.length === 0 && sharedSources.vaults.length === 0 && sharedSources.partitions.length === 0) {
        add(out, message('warn', 'There is nothing to search yet. Add documents in the Documents section' + (can('admin') ? ', or share a vault or partition in the Vaults section.' : '.')));
      }
    });

    var button = el('button', { class: 'primary', type: 'submit' }, 'Search');
    var form = el('form', {
      class: 'card',
      onsubmit: function (event) {
        event.preventDefault();
        var text = query.value.trim();
        if (!text) return;
        clear(out);
        button.disabled = true;
        add(out, el('p', { class: 'empty' }, 'Searching...'));
        var bodyJson = { query: text, k: Number(count.value) };
        var target = collection.value;
        if (target.slice(0, 2) === 'c:') bodyJson.collection = target.slice(2);
        else if (target.slice(0, 2) === 'v:') bodyJson.vault = target.slice(2);
        else if (target.slice(0, 2) === 'p:') bodyJson.partition = target.slice(2);
        api('POST', '/v1/search', { body: bodyJson }).then(function (data) {
          clear(out);
          (data.warnings || []).forEach(function (w) { add(out, message('warn', w)); });
          if (data.results.length === 0) {
            var where = data.vault ? 'the vault "' + data.vault + '"' : data.partition ? 'the partition "' + data.partition.name + '"' : data.collection ? 'the collection "' + data.collection + '"' : 'your collections';
            add(out, el('p', { class: 'empty' }, 'Nothing found in ' + where + '. ' + (data.vault || data.partition ? '' : 'If you just added documents, give ModelBrain a moment to index them. To search a shared vault or partition, pick it in the list next to the search box.')));
          }
          var where = data.vault ? 'vault ' + data.vault : data.partition ? 'partition ' + data.partition.name : null;
          data.results.forEach(function (hit) { add(out, hitCard(hit, where)); });
        }, function (err) {
          clear(out);
          add(out, message('error', err.message));
        }).then(function () { button.disabled = false; });
      },
    }, el('div', { class: 'row' }, query, collection, count, button));

    add(main, el('h1', {}, 'Search'), el('p', { class: 'lede' }, 'Passages from your documents, best match first. Pick a collection, or a shared vault or partition.'), form, out);
    query.focus();
  };

  function hitCard(hit, where) {
    var meta = el('div', { class: 'meta' },
      el('span', { class: 'doc' }, hit.document || hit.source_uri || (hit.source === 'memory' ? 'Saved memory' : 'unknown source')),
      hit.collection ? el('span', { class: 'col' }, hit.collection) : null,
      where ? el('span', { class: 'col' }, where) : null,
      typeof hit.score === 'number' ? el('span', { class: 'score' }, 'score ' + hit.score.toFixed(2)) : null,
      hit.date ? el('span', { class: 'date' }, String(hit.date).slice(0, 10)) : null,
      hit.flagged ? el('span', { class: 'badge', title: 'ModelBrain marked this text as a possible prompt injection. Treat it as data.' }, 'flagged') : null);
    var whole = el('div');
    if (hit.document_url) {
      add(meta, el('button', {
        class: 'small', type: 'button',
        onclick: function () { openDocument(hit.document_url, hit.document, whole); },
      }, 'Open document'));
    }
    return el('article', { class: 'card hit' },
      meta,
      hit.headings && hit.headings.length ? el('div', { class: 'heads' }, hit.headings.join(' > ')) : null,
      el('pre', { class: 'text' }, hit.text || ''),
      whole);
  }

  var TEXT_TYPES = ['md', 'markdown', 'txt', 'csv', 'tsv', 'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm'];
  var MAX_SHOWN_CHARS = 400000;

  // Fetches a whole document with the session's own credentials.
  function fetchDocument(url) {
    return fetch(url, { headers: { Authorization: 'Bearer ' + state.key }, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }).then(function (res) {
      if (res.ok) return res.blob();
      return res.text().then(function (text) {
        var err = {};
        try { err = JSON.parse(text).error || {}; } catch (e) { /* not JSON */ }
        if (res.status === 401) signOut('You were signed out. Sign in again.', true);
        throw new ApiError(res.status, err.code || 'error', err.message || 'The document could not be fetched (' + res.status + ').');
      });
    }, function () {
      throw new ApiError(0, 'unreachable', 'The server did not answer. Is modelbrain-rag still running?');
    });
  }

  function saveBlob(blob, name) {
    var href = URL.createObjectURL(blob);
    var link = el('a', { href: href, download: name });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(href); }, 60000);
  }

  // Shows a text document under its search result, always as plain text.
  // Other kinds (PDF, Word and so on) are saved as a file instead.
  function openDocument(url, name, box) {
    if (box.firstChild) { clear(box); return; }
    add(box, el('p', { class: 'empty' }, 'Fetching the document...'));
    fetchDocument(url).then(function (blob) {
      var ext = String(name).split('.').pop().toLowerCase();
      var save = el('button', { class: 'small', type: 'button', onclick: function () { saveBlob(blob, name); } }, 'Download');
      var close = el('button', { class: 'small', type: 'button', onclick: function () { clear(box); } }, 'Close');
      if (TEXT_TYPES.indexOf(ext) === -1) {
        clear(box);
        saveBlob(blob, name);
        add(box, el('div', { class: 'whole' }, el('div', { class: 'row' }, el('strong', {}, name), el('span', { class: 'meta' }, 'Saved to your downloads.'), save, close)));
        return;
      }
      return blob.text().then(function (text) {
        clear(box);
        var cut = text.length > MAX_SHOWN_CHARS;
        add(box, el('div', { class: 'whole' },
          el('div', { class: 'row' }, el('strong', {}, name), save, close),
          cut ? el('p', { class: 'empty' }, 'This is the start of a long document. Download it to read the rest.') : null,
          el('pre', { class: 'text doc-text' }, cut ? text.slice(0, MAX_SHOWN_CHARS) : text)));
      });
    }).then(null, function (err) {
      clear(box);
      add(box, message('error', err.message));
    });
  }

  // ---------- documents ----------

  views.documents = function (main) {
    var writer = can('write');
    var note = el('div');
    var list = el('div', { class: 'collist' });
    var pane = el('div');
    var current = null;

    function refresh(select) {
      return loadCollections().then(function (cols) {
        clear(list);
        if (cols.length === 0) add(list, el('p', { class: 'empty' }, 'No collections yet.'));
        if (lastSkipped.length) add(list, el('p', { class: 'empty', title: lastSkipped.join(', ') }, lastSkipped.length + ' folder' + (lastSkipped.length === 1 ? '' : 's') + ' in the documents folder cannot be used here because of the name: ' + lastSkipped.slice(0, 5).join(', ') + (lastSkipped.length > 5 ? ', ...' : '')));
        cols.forEach(function (c) {
          add(list, el('button', {
            type: 'button', 'aria-current': c.name === select ? 'true' : null,
            onclick: function () { open(c.name); },
          }, el('span', {}, c.name), el('span', { class: 'n' }, c.documents + (c.truncated ? '+' : ''))));
        });
        if (select && !cols.some(function (c) { return c.name === select; })) {
          current = null;
          clear(pane);
        }
      }, function (err) { add(note, message('error', err.message)); });
    }

    function open(name, keepNote) {
      current = name;
      if (!keepNote) clear(note);
      refresh(name);
      clear(pane);
      add(pane, el('p', { class: 'empty' }, 'Loading...'));
      api('GET', '/v1/collections/' + seg(name) + '/documents').then(function (data) {
        clear(pane);
        add(pane, el('div', { class: 'row spread' }, el('h2', {}, name),
          writer ? confirmButton('Delete collection', 'Confirm: delete empty collection', function () {
            api('DELETE', '/v1/collections/' + seg(name)).then(function () {
              current = null;
              clear(pane);
              refresh(null);
            }, function (err) { add(note, message('error', err.message)); open(name, true); });
          }) : null));
        if (writer) add(pane, uploader(name));
        if (data.truncated) add(pane, message('warn', 'Only the first 10,000 files are listed.'));
        if (data.documents.length === 0) {
          add(pane, el('p', { class: 'empty' }, 'No documents in this collection.'));
          return;
        }
        var rows = data.documents.map(function (doc) {
          var nested = doc.name.indexOf('/') !== -1;
          return el('tr', {},
            el('td', {}, doc.name, ' ', doc.searchable ? null : el('span', { class: 'badge off', title: 'ModelBrain does not read this file type.' }, 'not searched')),
            el('td', { class: 'num' }, fmtBytes(doc.bytes)),
            el('td', { class: 'num' }, fmtDate(doc.modified)),
            el('td', { class: 'act' }, writer && !nested ? confirmButton('Delete', 'Confirm delete', function () {
              api('DELETE', '/v1/collections/' + seg(name) + '/documents/' + seg(doc.name)).then(function () { open(name); },
                function (err) { add(note, message('error', err.message)); open(name, true); });
            }) : null));
        });
        add(pane, el('div', { class: 'card' }, el('table', {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Document'), el('th', {}, 'Size'), el('th', {}, 'Changed'), el('th', {}, ''))),
          el('tbody', {}, rows))));
      }, function (err) {
        clear(pane);
        add(pane, message('error', err.message));
      });
    }

    function uploader(name) {
      var input = el('input', { type: 'file', multiple: true, hidden: true });
      var drop = el('div', { class: 'drop' }, 'Drop files here, or ',
        el('button', { class: 'small', type: 'button', onclick: function () { input.click(); } }, 'choose files'));
      function send(files) {
        var queue = Array.prototype.slice.call(files);
        if (queue.length === 0) return;
        var failed = [];
        var done = 0;
        clear(note);
        function next() {
          var file = queue.shift();
          if (!file) {
            if (failed.length) add(note, message('error', failed.join(' ')));
            else add(note, message('ok', done + ' file' + (done === 1 ? '' : 's') + ' added. ModelBrain indexes them shortly.'));
            open(name, true);
            return;
          }
          api('PUT', '/v1/collections/' + seg(name) + '/documents/' + seg(file.name), { raw: file }).then(function () {
            done += 1;
          }, function (err) {
            failed.push(file.name + ': ' + err.message);
          }).then(next);
        }
        next();
      }
      input.addEventListener('change', function () { send(input.files); input.value = ''; });
      drop.addEventListener('dragover', function (event) { event.preventDefault(); drop.className = 'drop over'; });
      drop.addEventListener('dragleave', function () { drop.className = 'drop'; });
      drop.addEventListener('drop', function (event) {
        event.preventDefault();
        drop.className = 'drop';
        send(event.dataTransfer.files);
      });
      return el('div', {}, drop, input);
    }

    var side = el('div', {}, list);
    if (writer) {
      var name = el('input', { type: 'text', placeholder: 'New collection', 'aria-label': 'New collection name', maxlength: 200 });
      add(side, el('form', {
        class: 'row nowrap',
        onsubmit: function (event) {
          event.preventDefault();
          var value = name.value.trim();
          if (!value) return;
          clear(note);
          api('POST', '/v1/collections', { body: { name: value } }).then(function (made) {
            name.value = '';
            open(made.name);
          }, function (err) { add(note, message('error', err.message)); });
        },
      }, el('div', { class: 'grow' }, name), el('button', { type: 'submit' }, 'Add')));
    }

    add(main, el('h1', {}, 'Documents'),
      el('p', { class: 'lede' }, 'Each collection is a folder inside the documents folder. Files you put there by hand show up here too.'),
      note, el('div', { class: 'split' }, side, pane));
    refresh(null);
  };

  // ---------- keys ----------

  views.keys = function (main) {
    var note = el('div');
    var table = el('div');
    var fresh = el('div');

    function refresh() {
      api('GET', '/v1/keys').then(function (data) {
        clear(table);
        var rows = data.keys.map(function (k) {
          return el('tr', {},
            el('td', {}, k.name),
            el('td', { class: 'mono' }, k.access),
            el('td', {}, k.collections ? k.collections.join(', ') : 'all'),
            el('td', { class: 'num' }, fmtDate(k.created)),
            el('td', { class: 'num' }, fmtDate(k.last_used)),
            el('td', {}, k.revoked ? el('span', { class: 'badge' }, 'revoked') : el('span', { class: 'badge ok' }, 'active')),
            el('td', { class: 'act' }, k.revoked ? null : confirmButton('Revoke', 'Confirm revoke', function () {
              clear(note);
              api('DELETE', '/v1/keys/' + seg(k.id)).then(refresh, function (err) {
                add(note, message('error', err.message));
                refresh();
              });
            })));
        });
        add(table, el('div', { class: 'card' }, el('table', {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'Access'), el('th', {}, 'Collections'), el('th', {}, 'Made'), el('th', {}, 'Last used'), el('th', {}, 'State'), el('th', {}, ''))),
          el('tbody', {}, rows))));
      }, function (err) { add(note, message('error', err.message)); });
    }

    var name = el('input', { type: 'text', class: 'grow', placeholder: 'Name, for example: reporting app', 'aria-label': 'Key name', maxlength: 100 });
    var access = el('select', { 'aria-label': 'Access level' },
      el('option', { value: 'read' }, 'read: search and list'),
      el('option', { value: 'write' }, 'write: also add and remove documents'),
      el('option', { value: 'admin' }, 'admin: also manage keys'));
    var checks = collectionChecks(access, null);
    var limitNote = el('div', { class: 'label' }, 'Limit to (leave all unticked for everything)');

    var form = el('form', {
      class: 'card',
      onsubmit: function (event) {
        event.preventDefault();
        clear(note);
        clear(fresh);
        var chosen = checks.chosen();
        var bodyJson = { name: name.value.trim(), access: access.value };
        if (chosen.length) bodyJson.collections = chosen;
        api('POST', '/v1/keys', { body: bodyJson }).then(function (made) {
          name.value = '';
          var copied = el('span', { class: 'label' });
          add(fresh, el('div', { class: 'msg warn' },
            'New key "' + made.name + '". Copy it now: it cannot be shown again.',
            el('div', { class: 'newkey' }, made.key),
            el('div', { class: 'row' },
              el('button', {
                class: 'small', type: 'button',
                onclick: function () {
                  if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(made.key).then(function () { copied.textContent = 'Copied'; },
                      function () { copied.textContent = 'Select the key and copy it by hand'; });
                  } else copied.textContent = 'Select the key and copy it by hand';
                },
              }, 'Copy'),
              el('button', { class: 'small', type: 'button', onclick: function () { clear(fresh); } }, 'Done, hide it'),
              copied)));
          refresh();
        }, function (err) { add(note, message('error', err.message)); });
      },
    },
      el('div', { class: 'row' }, name, access, el('button', { class: 'primary', type: 'submit' }, 'Make key')),
      el('br'), limitNote, checks);

    add(main, el('h1', {}, 'API keys'),
      el('p', { class: 'lede' }, 'Each app gets its own key. Keys are stored only as hashes, so a lost key is replaced, not recovered.'),
      note, fresh, el('h2', {}, 'Make a key'), form, el('h2', {}, 'Keys'), table);
    refresh();
  };

  // ---------- vaults and partitions ----------

  views.sources = function (main) {
    var note = el('div');
    var vaultBox = el('div');
    var partBox = el('div');

    function toggle(kind, item) {
      return el('button', {
        class: 'small' + (item.shared ? '' : ' primary'), type: 'button',
        onclick: function () {
          clear(note);
          api('PUT', '/v1/' + kind + '/' + seg(item.id), { body: { shared: !item.shared } }).then(refresh, function (err) {
            add(note, message('error', err.message));
            refresh();
          });
        },
      }, item.shared ? 'Stop sharing' : 'Share');
    }

    function state(item) {
      return item.shared ? el('span', { class: 'badge ok' }, 'shared') : el('span', { class: 'badge off' }, 'not shared');
    }

    function refresh() {
      api('GET', '/v1/vaults').then(function (data) {
        clear(vaultBox);
        if (data.vaults.length === 0) {
          add(vaultBox, el('p', { class: 'empty' }, 'ModelBrain has no vaults yet. Add one in the ModelBrain app.'));
          return;
        }
        add(vaultBox, el('div', { class: 'card' }, el('table', {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Vault'), el('th', {}, 'Kind'), el('th', {}, 'Files'), el('th', {}, 'Folder'), el('th', {}, 'State'), el('th', {}, ''))),
          el('tbody', {}, data.vaults.map(function (v) {
            return el('tr', {},
              el('td', {}, v.id, v.documents_folder ? ' (documents folder)' : ''),
              el('td', { class: 'num' }, v.kind),
              el('td', { class: 'num' }, v.files === null ? '' : v.files),
              el('td', { class: 'mono' }, v.root || ''),
              el('td', {}, state(v)),
              el('td', { class: 'act' }, toggle('vaults', v)));
          })))));
      }, function (err) { clear(vaultBox); add(vaultBox, message('error', err.message)); });

      api('GET', '/v1/partitions').then(function (data) {
        clear(partBox);
        add(partBox, el('div', { class: 'card' }, el('table', {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Partition'), el('th', {}, 'Id'), el('th', {}, 'State'), el('th', {}, ''))),
          el('tbody', {}, data.partitions.map(function (p) {
            return el('tr', {},
              el('td', {}, p.name, p.is_default ? ' (default)' : ''),
              el('td', { class: 'mono' }, p.id),
              el('td', {}, state(p)),
              el('td', { class: 'act' }, toggle('partitions', p)));
          })))));
      }, function (err) { clear(partBox); add(partBox, message('error', err.message)); });
    }

    add(main, el('h1', {}, 'Vaults and partitions'),
      el('p', { class: 'lede' }, 'Everything ModelBrain holds, beyond the documents folder. Nothing here can be searched through this server until you share it. Sharing is search-only: this server never changes a vault or partition.'),
      note,
      el('h2', {}, 'Vaults'),
      el('p', { class: 'lede' }, 'Folders and other sources ModelBrain indexes. Some kinds, such as mail, hold private material.'),
      vaultBox,
      el('h2', {}, 'Partitions'),
      el('p', { class: 'lede' }, 'A partition holds saved memories as well as documents. Sharing one makes those memories searchable here.'),
      partBox);
    refresh();
  };

  // ---------- users ----------

  function accessSelect(current, short) {
    var select = el('select', { 'aria-label': 'Access level' },
      el('option', { value: 'read' }, short ? 'read' : 'read: search and browse'),
      el('option', { value: 'write' }, short ? 'write' : 'write: also add and remove documents'),
      el('option', { value: 'admin' }, short ? 'admin' : 'admin: also manage users, keys and settings'));
    if (current) select.value = current;
    return select;
  }

  // Tick boxes for limiting a user or key to collections, shared vaults
  // and shared partitions.
  function collectionChecks(access, chosen) {
    var box = el('div', { class: 'checks' });
    function sync() {
      var admin = access.value === 'admin';
      Array.prototype.forEach.call(box.querySelectorAll('input'), function (input) {
        input.disabled = admin;
        if (admin) input.checked = false;
      });
    }
    function tick(value, label) {
      add(box, el('label', {}, el('input', { type: 'checkbox', value: value, checked: chosen && chosen.indexOf(value) !== -1 }), label));
    }
    Promise.all([loadCollections().then(null, function () { return []; }), loadShared()]).then(function (both) {
      both[0].forEach(function (c) { tick(c.name, c.name); });
      both[1].vaults.forEach(function (v) { tick('vault:' + v.id, 'vault: ' + v.id); });
      both[1].partitions.forEach(function (p) { tick('partition:' + p.id, 'partition: ' + p.name); });
      if (!box.firstChild) add(box, el('span', { class: 'empty' }, 'Nothing to limit to yet.'));
      sync();
    });
    access.addEventListener('change', sync);
    box.chosen = function () {
      return Array.prototype.filter.call(box.querySelectorAll('input'), function (input) { return input.checked; })
        .map(function (input) { return input.value; });
    };
    return box;
  }

  views.users = function (main) {
    var note = el('div');
    var table = el('div');

    function fail(err) {
      clear(note);
      add(note, message('error', err.message));
    }

    function refresh() {
      api('GET', '/v1/users').then(function (data) {
        clear(table);
        var rows = data.users.map(function (u) {
          var self = u.username.toLowerCase() === state.me.name.toLowerCase();
          var access = accessSelect(u.access, true);
          access.className = 'small';
          access.addEventListener('change', function () {
            clear(note);
            api('PUT', '/v1/users/' + seg(u.username), { body: { access: access.value } }).then(function () {
              add(note, message('ok', u.username + ' now has ' + access.value + ' access.'));
              refresh();
            }, function (err) { fail(err); refresh(); });
          });
          var reset = el('button', {
            class: 'small', type: 'button',
            onclick: function () { passwordForm(u.username); },
          }, 'Set password');
          var toggle = el('button', {
            class: 'small', type: 'button',
            onclick: function () {
              clear(note);
              api('PUT', '/v1/users/' + seg(u.username), { body: { disabled: !u.disabled } }).then(refresh, function (err) { fail(err); refresh(); });
            },
          }, u.disabled ? 'Enable' : 'Disable');
          var remove = confirmButton('Remove', 'Confirm remove', function () {
            clear(note);
            api('DELETE', '/v1/users/' + seg(u.username)).then(refresh, function (err) { fail(err); refresh(); });
          });
          return el('tr', {},
            el('td', {}, u.username, self ? ' (you)' : ''),
            el('td', {}, self ? u.access : access),
            el('td', {}, u.collections ? u.collections.join(', ') : 'all'),
            el('td', { class: 'num' }, fmtDate(u.last_login)),
            el('td', {}, u.disabled ? el('span', { class: 'badge' }, 'disabled') : el('span', { class: 'badge ok' }, 'active')),
            el('td', { class: 'act' }, self ? null : [reset, ' ', toggle, ' ', remove]));
        });
        add(table, el('div', { class: 'card' }, el('table', {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Username'), el('th', {}, 'Access'), el('th', {}, 'Collections'), el('th', {}, 'Last sign-in'), el('th', {}, 'State'), el('th', {}, ''))),
          el('tbody', {}, rows))));
      }, fail);
    }

    var setBox = el('div');
    function passwordForm(username) {
      clear(setBox);
      var pw = el('input', { type: 'password', class: 'grow', autocomplete: 'new-password', placeholder: 'New password, 10 characters or more', 'aria-label': 'New password', maxlength: 200 });
      add(setBox, el('form', {
        class: 'card',
        onsubmit: function (event) {
          event.preventDefault();
          clear(note);
          api('PUT', '/v1/users/' + seg(username), { body: { password: pw.value } }).then(function () {
            clear(setBox);
            add(note, message('ok', 'Password changed for ' + username + '. Anyone signed in as this user was signed out.'));
          }, fail);
        },
      }, el('div', { class: 'label' }, 'New password for ' + username),
        el('div', { class: 'row' }, pw, el('button', { class: 'primary', type: 'submit' }, 'Save'),
          el('button', { type: 'button', onclick: function () { clear(setBox); } }, 'Cancel'))));
      pw.focus();
    }

    var username = el('input', { type: 'text', class: 'grow', placeholder: 'Username', 'aria-label': 'Username', autocomplete: 'off', maxlength: 64 });
    var password = el('input', { type: 'password', class: 'grow', placeholder: 'Password, 10 characters or more', 'aria-label': 'Password', autocomplete: 'new-password', maxlength: 200 });
    var access = accessSelect('read');
    var checks = collectionChecks(access, null);
    var form = el('form', {
      class: 'card',
      onsubmit: function (event) {
        event.preventDefault();
        clear(note);
        var bodyJson = { username: username.value.trim(), password: password.value, access: access.value };
        var chosen = checks.chosen();
        if (chosen.length) bodyJson.collections = chosen;
        api('POST', '/v1/users', { body: bodyJson }).then(function (made) {
          username.value = '';
          password.value = '';
          add(note, message('ok', 'Added ' + made.username + '. Give them the password; they can change it after signing in.'));
          refresh();
        }, fail);
      },
    },
      el('div', { class: 'row' }, username, password, access, el('button', { class: 'primary', type: 'submit' }, 'Add user')),
      el('br'), el('div', { class: 'label' }, 'Limit to (leave all unticked for everything)'), checks);

    add(main, el('h1', {}, 'Users'),
      el('p', { class: 'lede' }, 'People who can sign in to this page. Passwords are stored only as hashes.'),
      note, setBox, el('h2', {}, 'Add a user'), form, el('h2', {}, 'Users'), table);
    refresh();
  };

  // ---------- account ----------

  views.account = function (main) {
    var note = el('div');
    var current = el('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Current password', maxlength: 200 });
    var next = el('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'New password', maxlength: 200 });
    var again = el('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'New password again', maxlength: 200 });
    var form = el('form', {
      class: 'card',
      onsubmit: function (event) {
        event.preventDefault();
        clear(note);
        if (next.value !== again.value) {
          add(note, message('error', 'The two new passwords do not match.'));
          return;
        }
        api('PUT', '/v1/me/password', { keepSession: true, body: { current: current.value, new: next.value } }).then(function (session) {
          state.key = session.token;
          try {
            sessionStorage.setItem(KEY_SLOT, session.token);
          } catch (e) { /* stays signed in until the page closes */ }
          current.value = '';
          next.value = '';
          again.value = '';
          add(note, message('ok', 'Password changed. Other places where you were signed in have been signed out.'));
        }, function (err) {
          add(note, message('error', err.code === 'invalid_login' ? 'The current password is not right.' : err.message));
        });
      },
    },
      el('dl', {},
        el('dt', {}, 'Current password'), el('dd', {}, current),
        el('dt', {}, 'New password'), el('dd', {}, next),
        el('dt', {}, 'New password again'), el('dd', {}, again)),
      el('br'), el('button', { class: 'primary', type: 'submit' }, 'Change password'));

    add(main, el('h1', {}, 'Account'),
      el('p', { class: 'lede' }, 'Signed in as ' + state.me.name + ' with ' + state.me.access + ' access' + (state.me.collections ? ', limited to ' + state.me.collections.join(', ') : '') + '.'),
      note, el('h2', {}, 'Change password'), form);
  };

  // ---------- status and settings ----------

  views.status = function (main) {
    var out = el('div');
    add(main, el('h1', {}, 'Status'), el('p', { class: 'lede' }, 'ModelBrain does the indexing and searching. This page shows whether it is ready.'), out);

    function yes(ok, good, bad) {
      return el('span', { class: 'badge ' + (ok ? 'ok' : '') }, ok ? good : bad);
    }

    api('GET', '/v1/status').then(function (s) {
      var mb = s.modelbrain;
      var folder = s.documents_folder;
      if (!mb.installed) add(out, message('error', mb.message || 'ModelBrain is not installed.'));
      else if (!mb.reachable) add(out, message('error', mb.message || 'ModelBrain is not answering.'));
      else if (!folder.connected) {
        add(out, message('warn', folder.message));
        if (folder.path) {
          var copied = el('span', { class: 'meta' });
          add(out, el('div', { class: 'card' },
            el('h2', {}, 'One step left'),
            el('ol', { class: 'steps' },
              el('li', {}, 'Open ModelBrain from the menu bar and choose Add Vault.'),
              el('li', {}, 'Pick this folder: ', el('code', {}, folder.path), ' ',
                el('button', {
                  class: 'small', type: 'button',
                  onclick: function () {
                    var done = function (ok) { copied.textContent = ok ? ' Copied.' : ' Select the path and copy it by hand.'; };
                    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(folder.path).then(function () { done(true); }, function () { done(false); });
                    else done(false);
                  },
                }, 'Copy path'), copied),
              el('li', {}, 'Come back here. This page shows "Ready" once ModelBrain has the folder.'))));
        }
      }
      else if (folder.message) add(out, message('warn', folder.message));
      else add(out, message('ok', 'Ready. ModelBrain is indexing the documents folder.'));

      add(out, el('div', { class: 'card' }, el('dl', {},
        el('dt', {}, 'ModelBrain'), el('dd', {}, yes(mb.installed, 'installed', 'not installed'), ' ', mb.installed ? yes(mb.reachable, 'reachable', 'not answering') : null, mb.version ? ' version ' + mb.version : ''),
        folder.path ? el('dt', {}, 'Documents folder') : null, folder.path ? el('dd', {}, el('code', {}, folder.path)) : null,
        el('dt', {}, 'Indexed by ModelBrain'), el('dd', {}, yes(folder.connected, 'yes', 'not yet'), folder.connector_id ? ' as "' + folder.connector_id + '"' : ''),
        el('dt', {}, 'This server'), el('dd', {}, s.name + ' ' + s.version),
        el('dt', {}, 'Signed in as'), el('dd', {}, s.signed_in.name + ' (' + s.signed_in.access + (s.signed_in.collections ? ', limited to ' + s.signed_in.collections.join(', ') : '') + ')'))));

      if (can('admin')) settings(out);
    }, function (err) { add(out, message('error', err.message)); });
  };

  function settings(out) {
    var note = el('div');
    var box = el('div');
    add(out, el('h2', {}, 'Settings'), note, box);
    api('GET', '/v1/settings').then(function (s) {
      var port = el('input', { type: 'number', min: 1, max: 65535, value: s.port, 'aria-label': 'Port' });
      var form = el('form', {
        class: 'row',
        onsubmit: function (event) {
          event.preventDefault();
          clear(note);
          api('PUT', '/v1/settings', { body: { port: Number(port.value) } }).then(function (saved) {
            add(note, message('ok', saved.restart_required ? 'Saved. The new port takes effect the next time modelbrain-rag starts.' : 'Saved.'));
          }, function (err) { add(note, message('error', err.message)); });
        },
      }, port, el('button', { type: 'submit' }, 'Save port'));
      add(box, el('div', { class: 'card' }, el('dl', {},
        el('dt', {}, 'Listening on'), el('dd', {}, el('code', {}, 'http://127.0.0.1:' + s.listening_port), ' (this computer only)'),
        el('dt', {}, 'Port for next start'), el('dd', {}, form),
        el('dt', {}, 'Largest upload'), el('dd', {}, fmtBytes(s.max_upload_bytes)),
        el('dt', {}, 'Web pages allowed to call the API'), el('dd', {}, s.allow_origins.length ? s.allow_origins.join(', ') : 'none'),
        el('dt', {}, 'Settings folder'), el('dd', {}, el('code', {}, s.settings_dir || 'not saved to disk')))),
        el('p', { class: 'lede' }, 'The documents folder and allowed web origins are changed from the command line: ', el('code', {}, 'modelbrain-rag config set ...')));
      if (s.listening_port !== s.port) add(note, message('warn', 'Port ' + s.port + ' is saved and takes effect the next time modelbrain-rag starts.'));
    }, function (err) { add(note, message('error', err.message)); });
  }

  // ---------- start ----------

  var firstCode = setupCode();
  function signInOrSetup(note) {
    api('GET', '/health', { anonymous: true }).then(function (health) {
      if (health.needs_setup) renderSetup(firstCode);
      else renderSignIn(note);
    }, function () { renderSignIn(note); });
  }
  if (!state.key) {
    signInOrSetup();
  } else {
    api('GET', '/v1/status').then(function (status) {
      state.me = status.signed_in;
      renderApp(status);
    }, function (err) {
      // An old session from before a reinstall must not hide first-run setup.
      if (err.status === 401) signInOrSetup('You were signed out. Sign in again.');
      else renderSignIn(err.message);
    });
  }
})();
