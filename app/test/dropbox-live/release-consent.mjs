import {randomBytes} from 'node:crypto';

const scopes = ['files.content.read','files.content.write','files.metadata.read'];
const keyPattern = /^[A-Za-z0-9_-]{1,100}$/;
const pkcePattern = /^[A-Za-z0-9_-]{43}$/;
const authFields = ['client_id','response_type','token_access_type','redirect_uri','scope','state','code_challenge','code_challenge_method'];

function validateAuthorization(input, origin, key) {
  let url;
  try { url = new URL(input); }
  catch { throw Error('The release requested an invalid authorization address.'); }
  const params = url.searchParams;
  if (url.origin !== 'https://www.dropbox.com' || url.pathname !== '/oauth2/authorize' ||
      url.username || url.password || url.hash || params.size !== authFields.length ||
      authFields.some(field => params.getAll(field).length !== 1) ||
      params.get('client_id') !== key || params.get('redirect_uri') !== origin + '/' ||
      params.get('response_type') !== 'code' || params.get('token_access_type') !== 'offline' ||
      params.get('code_challenge_method') !== 'S256' || !pkcePattern.test(params.get('code_challenge')) ||
      !pkcePattern.test(params.get('state')) || params.get('scope').split(' ').sort().join(' ') !== scopes.join(' ')) {
    throw Error('The release requested an unexpected Dropbox authorization.');
  }
  return url;
}

function page(content, refresh = false) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>csvTV Dropbox check</title>' +
    (refresh ? '<meta http-equiv="refresh" content="2">' : '') +
    '<style>html{color-scheme:light dark;font:1.05rem/1.5 system-ui}main{max-width:32rem;margin:10vh auto;padding:1rem}' +
    'label,input,button{display:block}input,button{font:inherit;padding:.5rem;margin:.5rem 0 1rem}input{width:min(24rem,90%)}' +
    'h1{line-height:1.15}</style></head><body><main><h1>csvTV Dropbox check</h1>' + content + '</main></body></html>';
}

/** Only the human approves here. The isolated release retains its own PKCE verifier and exchanges the code. */
export function createReleaseConsent(origin, initialPublicKey = '', {acceptTmdb, ownerExports = false, clearCheck = false, controlsCheck = false} = {}) {
  if (origin !== 'http://localhost:8765') throw Error('Use the registered localhost redirect for this test.');
  if (initialPublicKey && !keyPattern.test(initialPublicKey)) throw Error('The Dropbox public app key is invalid.');
  const path = '/release-consent-' + randomBytes(24).toString('hex');
  const registration = Promise.withResolvers();
  registration.promise.catch(() => {}); // Closing before the owner registers can precede the runner's await.
  let key = initialPublicKey, pending, approved = 0, done, closed = false, checking = false;
  let needsTmdb = Boolean(acceptTmdb);
  const configured = () => Boolean(key && !needsTmdb);
  if (configured()) registration.resolve(key);

  function show(res, status = 200, error = '') {
    let content, refresh = false;
    if (done !== undefined || closed) {
      content = done ? '<p>The Dropbox test finished. You can close this tab.</p>' :
        '<p>The Dropbox test stopped. You can close this tab and check the result in the chat.</p>';
    } else if (!configured()) {
      content = (key ? '' : '<p>Use your development Dropbox app with <code>http://localhost:8765/</code> registered as its redirect.</p>') +
        (ownerExports ? '<p>csvTV will import your Trakt and AniList watch records into a new Dropbox test folder. It will match shows and episodes using TMDB, verify the record in a second browser, then remove that folder.</p>' : '') +
        (needsTmdb ? '<p>The temporary TMDB read token is saved in the test folder’s settings.csv. The test removes the folder when finished.</p>' : '') +
        (error ? '<p role="alert">' + error + '</p>' : '') +
        '<form method="post" action="' + path + '/key">' +
        (key ? '' : '<label for="key">Dropbox public app key</label><input id="key" name="key" required maxlength="100" autocomplete="off" spellcheck="false">') +
        (needsTmdb ? '<label for="tmdb">Temporary TMDB API Read Access Token</label><input id="tmdb" name="tmdb" type="password" required maxlength="4096" autocomplete="off" spellcheck="false">' : '') +
        '<button>Continue</button></form>';
    } else if (pending) {
      content = '<p>' + (approved ? 'Sign back into the same Dropbox account to verify the test record in a fresh browser.' :
        controlsCheck ? 'Sign in once to test Sync now, Back up now, Merge, Restore, Clear Dropbox and Sign out. The test uses a new folder with fictional records and keys, verifies the saved files, then removes the folder and revokes its sign-in.' :
        clearCheck ? 'Sign in once to test Clear Dropbox. The test creates a new folder with fictional watches, ratings, lists, keys and backups, checks what each clear removes, then deletes the test folder.' :
        'Sign in to the development app to verify the record in a new Dropbox test folder.') +
        '</p><a href="' + path + '/authorize">' +
        (approved ? 'Sign back in to Dropbox' : 'Continue to Dropbox') + '</a>';
    } else {
      content = '<p>' + (approved ? 'Dropbox returned you to the test. Keep this page open while csvTV checks the record.' :
        'Preparing the release for Dropbox sign-in. Keep this page open.') + '</p>';
      refresh = true;
    }
    res.writeHead(status,{'Content-Type':'text/html; charset=utf-8'}).end(page(content,refresh));
  }
  function returnToPortal(res) {
    res.writeHead(303,{Location:path}).end();
  }
  function clearPending() {
    if (pending) pending.result.reject(Error('The Dropbox consent handoff was closed.'));
    pending = undefined;
  }
  async function handle(req,res) {
    let url;
    try { url = new URL(req.url,origin); }
    catch { res.writeHead(400).end(); return true; }
    const callback = url.pathname === '/' && req.method === 'GET' && (url.searchParams.has('code') || url.searchParams.has('error'));
    if (callback && req.headers['user-agent'] === 'csvTV-release-check') return false;
    if (!callback && ![path,path+'/key',path+'/authorize'].includes(url.pathname)) return false;
    res.setHeader('Cache-Control','no-store');
    // Same-origin form navigation needs its Origin header for registration.
    // The OAuth navigation and callback must not forward a referrer.
    res.setHeader('Referrer-Policy',url.pathname === path ? 'same-origin' : 'no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('X-Content-Type-Options','nosniff');
    if (req.headers.host !== 'localhost:8765' || url.origin !== origin) { res.writeHead(403).end(); return true; }
    if (callback) {
      const states = url.searchParams.getAll('state'), codes = url.searchParams.getAll('code');
      if (!pending || states.length !== 1 || states[0] !== pending.state) { res.writeHead(400).end('Unrecognized sign-in.'); return true; }
      const result = pending.result;
      pending = undefined;
      if (url.searchParams.has('error') || codes.length !== 1 || !codes[0] || codes[0].length > 4096) {
        result.reject(Error('Dropbox authorization was declined or incomplete.'));
      } else {
        approved++;
        result.resolve({code:codes[0],state:states[0]});
      }
      returnToPortal(res);
    } else if (req.method === 'GET' && url.pathname === path) {
      show(res);
    } else if (req.method === 'GET' && url.pathname === path + '/authorize' && pending) {
      res.writeHead(303,{Location:pending.url}).end();
    } else if (req.method !== 'POST' || req.headers.origin !== origin) {
      res.writeHead(403).end();
    } else if (url.pathname === path + '/key' && !configured() && !closed && done === undefined) {
      if (req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {
        res.writeHead(415).end(); return true;
      }
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > (needsTmdb ? 8192 : 512)) { res.writeHead(413).end(); return true; }
      }
      const fields = new URLSearchParams(body), value = key || fields.get('key')?.trim();
      if (!value || !keyPattern.test(value) || (!key && fields.getAll('key').length !== 1)) {
        show(res,400,'Enter a valid public app key.'); return true;
      }
      if (configured() || closed || done !== undefined || checking) { returnToPortal(res); return true; }
      checking = true;
      try {
        if (needsTmdb) {
          const token = fields.get('tmdb')?.trim();
          if (fields.getAll('tmdb').length !== 1 || !token || !/^[a-zA-Z0-9._-]{1,4096}$/.test(token) || !await acceptTmdb(token)) {
            show(res,400,'Could not verify the TMDB read token. Check it and try again.'); return true;
          }
        }
        if (!closed && done === undefined) {
          key = value; needsTmdb = false; registration.resolve(key);
        }
        returnToPortal(res);
      } finally { checking = false; }
    } else returnToPortal(res);
    return true;
  }
  return {
    path, publicKey:registration.promise, handle,
    expectAuthorization(input) {
      if (!configured() || pending || closed || done !== undefined) throw Error('Dropbox sign-in is unavailable for this test.');
      const url = validateAuthorization(input,origin,key);
      const result = Promise.withResolvers();
      pending = {url:url.href,state:url.searchParams.get('state'),result};
      return result.promise;
    },
    markDone(success) { done = Boolean(success); clearPending(); },
    close() { closed = true; clearPending(); registration.reject(Error('Dropbox app registration was closed.')); key = ''; },
  };
}
