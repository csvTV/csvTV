import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function chromiumPath() {
  if (process.env.CSVTV_BROWSER) return process.env.CSVTV_BROWSER;
  const candidates = process.platform === 'win32' ? [
    join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
    join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe'),
  ] : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  for (const path of candidates) {
    try { await access(path); return path; } catch { /* Try another standard installation. */ }
  }
  throw Error('Set CSVTV_BROWSER to a Chromium executable to run offline acceptance.');
}

export async function until(probe, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await probe();
    if (result) return result;
    await delay(80);
  } while (Date.now() < deadline);
  throw Error('Timed out waiting for ' + description);
}

// A Windows Edge launcher can hand off silently and omit the port file on a cold reopen.
async function edgeLoopbackPort() {
  const reservation = createServer();
  const listening = once(reservation, 'listening');
  reservation.listen({host:'127.0.0.1', port:0, exclusive:true});
  await listening;
  const port = reservation.address().port;
  await new Promise((resolve,reject) => reservation.close(error => error ? reject(error) : resolve()));
  return port;
}

// Standard acceptance tests cannot resolve external hosts. A live probe admits only its selected provider.
export async function openChromium(profile, onRequest, {liveProvider, dropboxReleaseCheck = false} = {}) {
  const liveHost = {MDBList:'api.mdblist.com', OMDb:'www.omdbapi.com', AniListMapping:'raw.githubusercontent.com'}[liveProvider];
  const executable = await chromiumPath();
  const edge = process.platform === 'win32' && /[\\/]msedge\.exe$/i.test(executable);
  const markerFile = join(profile,'DevToolsActivePort');
  const priorMarker = !edge && await readFile(markerFile,'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw Error('Could not read the Chromium profile marker (' + error.code + ')');
  });
  const initial = 'data:text/html,%3Ctitle%3Ecsvtv-' + randomUUID() + '%3C/title%3E';
  const assignedPort = edge ? await edgeLoopbackPort() : 0;
  const child = spawn(executable, ['--headless', '--disable-gpu',
    '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4',
    '--disable-background-networking', '--disable-sync', '--disable-component-update',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=' + assignedPort,
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost' + (liveHost ? ', EXCLUDE ' + liveHost : ''),
    ...(dropboxReleaseCheck ? ['--user-agent=csvTV-release-check'] : []),
    '--no-proxy-server', '--user-data-dir=' + profile, initial],
  { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const exited = once(child, 'exit');
  let socket, closing, launchError, endpoint;
  exited.catch(error => { launchError = error; });
  function close() {
    closing ??= (async () => {
      // Edge's launcher can exit before the actual browser. Wait for the authenticated connection to close too.
      if (edge && child.exitCode === 0 && socket?.readyState !== WebSocket.OPEN && endpoint) {
        const cleanup = new WebSocket(endpoint);
        try {
          await once(cleanup, 'open', {signal:AbortSignal.timeout(1500)});
          socket?.close();
          socket = cleanup;
        } catch { cleanup.close(); }
      }
      const closed = socket && socket.readyState !== WebSocket.CLOSED ? once(socket,'close') : Promise.resolve();
      const end = Promise.withResolvers(), timer = setTimeout(end.resolve,5000);
      try {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({id:0,method:'Browser.close'}));
        else if (child.pid && child.exitCode === null && child.signalCode === null) child.kill();
        await Promise.race([Promise.allSettled([exited,closed]),end.promise]);
      } finally {
        clearTimeout(timer);
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exited.catch(() => {});
        }
        socket?.close();
        child.stderr.destroy();
      }
    })();
    return closing;
  }
  try {
    const deadline = AbortSignal.timeout(30000);
    let stderrTail = '', announced, stage = 'waiting for a debugging port';
    child.stderr.on('data', chunk => {
      if (announced) return;
      const output = stderrTail + chunk.toString();
      announced = /DevTools listening on ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})(\/devtools\/browser\/[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})/i.exec(output);
      stderrTail = output.slice(-128);
    });
    while (!endpoint && !deadline.aborted) {
      if (launchError) throw Error('Chromium could not start (' + (launchError.code ?? 'spawn error') + ')');
      if ((child.exitCode !== null && !(edge && child.exitCode === 0)) || child.signalCode !== null)
        throw Error('Chromium exited while ' + stage + ' (' + (child.signalCode ?? child.exitCode) + ')');
      // A reused profile can still name the previous browser. Every launch gets its own page, even if the OS reuses its port.
      const marker = !edge && await readFile(markerFile,'utf8').catch(() => undefined);
      const freshMarker = marker && marker !== priorMarker && /^(\d{1,5})\r?\n(\/devtools\/browser\/[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\s*$/i.exec(marker);
      const debugging = freshMarker || announced;
      const port = assignedPort || debugging?.[1];
      if (Number(port) > 0 && Number(port) <= 65535) {
        try {
          stage = 'connecting to the debugging service';
          const reply = await fetch('http://127.0.0.1:' + port + '/json/list', {
            redirect:'error',signal:AbortSignal.any([deadline,AbortSignal.timeout(1000)])});
          stage = 'waiting for the isolated startup page';
          // A port can be taken between releasing it and starting Edge. Never control or close an unrelated target.
          const page = (await reply.json()).find(target => target.type === 'page' && target.url === initial);
          if (page) {
            const url = new URL(page.webSocketDebuggerUrl);
            if (url.origin === 'ws://127.0.0.1:' + port && /^\/devtools\/page\/[\da-f]+$/i.test(url.pathname) &&
                !url.search && !url.hash && !url.username && !url.password) endpoint = url;
          }
        } catch { /* The marker can appear before the page is ready. */ }
      }
      if (!endpoint) await delay(50);
    }
    if (!endpoint) throw Error('Chromium startup timed out while ' + stage);
    socket = new WebSocket(endpoint);
    try { await once(socket, 'open',{signal:deadline}); }
    catch { throw Error('Chromium could not connect to its isolated startup page'); }
    const waiting = new Map();
    let sequence = 0, fixtureError;
    function send(method, params = {}) {
      if (socket.readyState !== WebSocket.OPEN) return Promise.reject(Error('Chromium connection closed'));
      const id = ++sequence;
      const result = new Promise((resolve, reject) => waiting.set(id, {resolve, reject}));
      socket.send(JSON.stringify({id, method, params}));
      return result;
    }
    socket.addEventListener('message', ({data}) => {
      const message = JSON.parse(data);
      if (message.id) {
        const listener = waiting.get(message.id);
        waiting.delete(message.id);
        if (message.error) listener.reject(Error(message.error.message));
        else listener.resolve(message.result);
      } else if (message.method === 'Fetch.requestPaused') {
        const {requestId} = message.params;
        let answered = false;
        async function answer(method, params) {
          if (answered || params.requestId !== requestId) throw Error('The fixture must answer its own paused request once.');
          answered = true;
          try { return await send(method, params); }
          catch (error) {
            // Aborting a fetch invalidates its interception ID even when the fixture already prepared the reply.
            if (error.message !== 'Invalid InterceptionId.') throw error;
          }
        }
        onRequest(message.params, answer).catch(error => {
          fixtureError = error;
          if (!answered) void send('Fetch.failRequest', { requestId, errorReason:'Failed' }).catch(() => {});
        });
      }
    });
    function stopCommands(reason) {
      for (const listener of waiting.values()) listener.reject(Error(reason));
      waiting.clear();
    }
    socket.addEventListener('close', () => stopCommands('Chromium connection closed'));
    const timedOut = () => stopCommands('Chromium did not initialize its isolated page');
    deadline.addEventListener('abort',timedOut,{once:true});
    try {
      deadline.throwIfAborted();
      await send('Page.enable');
      await send('Network.enable');
      await send('Network.setCacheDisabled', {cacheDisabled:true});
      await send('Fetch.enable', {patterns: [
        ...(dropboxReleaseCheck ? [{urlPattern:'https://www.dropbox.com/oauth2/authorize*'}] : []),
        {urlPattern:'https://*.dropboxapi.com/*'}, {urlPattern:'https://api.themoviedb.org/*'},
        ...['api.mdblist.com','www.omdbapi.com','api.github.com','raw.githubusercontent.com'].filter(host => host !== liveHost)
          .map(host => ({urlPattern:'https://' + host + '/*'})),
      ]});
      // DevTools can announce the target before it has committed the startup document.
      await until(() => {
        deadline.throwIfAborted();
        return evaluate('location.href === ' + JSON.stringify(initial) + ' && document.readyState === "complete"');
      }, 'the isolated startup document to load');
    } finally { deadline.removeEventListener('abort',timedOut); }

    async function evaluate(expression) {
      if (fixtureError) throw fixtureError;
      const {result, exceptionDetails} = await send('Runtime.evaluate', {
        expression, awaitPromise:true, returnByValue:true, userGesture:true,
      });
      if (exceptionDetails) throw Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      return result.value;
    }
    async function waitFor(expression, label) {
      return until(() => evaluate(expression), label ?? expression);
    }
    async function click(selector) {
      await waitFor(`(() => {
        const button = document.querySelector(${JSON.stringify(selector)});
        if (!button || button.matches(':disabled')) return false;
        button.click();
        return true;
      })()`, selector);
    }
    async function download(selector, filename) {
      const finished = Promise.withResolvers();
      let guid;
      function watch(event) {
        const {method, params} = JSON.parse(event.data);
        if (method === 'Browser.downloadWillBegin' && params.suggestedFilename === filename) guid = params.guid;
        if (!guid || method !== 'Browser.downloadProgress' || params.guid !== guid) return;
        if (params.state === 'completed') finished.resolve();
        if (params.state === 'canceled') finished.reject(Error('Chromium canceled the download of ' + filename));
      }
      socket.addEventListener('message',watch);
      const timer = setTimeout(()=>finished.reject(Error('Download did not finish: ' + filename)),15000);
      try { await Promise.all([finished.promise,click(selector)]); }
      finally { clearTimeout(timer); socket.removeEventListener('message',watch); }
    }
    async function navigate(url) {
      let timer;
      const timeout = new Promise((resolve,reject) => {
        timer = setTimeout(() => reject(Error('No navigation response for ' + url)), 12000);
      });
      const {errorText} = await Promise.race([send('Page.navigate', {url}), timeout]).finally(() => clearTimeout(timer));
      if (errorText) throw Error('Navigation failed: ' + errorText);
      await waitFor('location.href === ' + JSON.stringify(url) + ' && document.readyState === "complete"', 'document at ' + url);
    }
    async function offline(value) {
      await send('Network.emulateNetworkConditions', {offline:value, latency:0, downloadThroughput:-1, uploadThroughput:-1});
    }
    async function press(key, {shift = false} = {}) {
      const windowsVirtualKeyCode = {Tab:9, Enter:13, Escape:27, Space:32, End:35, Home:36, ArrowLeft:37, ArrowUp:38, ArrowRight:39, ArrowDown:40}[key];
      const text = {Enter:'\r', Space:' '}[key] ?? '';
      const fields = {key:key === 'Space' ? ' ' : key, code:key, windowsVirtualKeyCode, modifiers:shift ? 8 : 0};
      await send('Input.dispatchKeyEvent', {type:text ? 'keyDown':'rawKeyDown', ...fields, text});
      await send('Input.dispatchKeyEvent', {type:'keyUp', ...fields});
    }
    return {send, evaluate, waitFor, click, download, navigate, offline, press, close};
  } catch (error) {
    await close();
    throw error;
  }
}
