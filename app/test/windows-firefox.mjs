import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

/** Drive a new, isolated profile in the installed Windows Firefox using WebDriver BiDi. */
export async function openWindowsFirefox(profile) {
  const prefs = {'browser.shell.checkDefaultBrowser':false,'datareporting.healthreport.uploadEnabled':false,
    'network.proxy.type':1,'network.proxy.http':'127.0.0.1','network.proxy.http_port':9,
    'network.proxy.ssl':'127.0.0.1','network.proxy.ssl_port':9,'network.proxy.no_proxies_on':'localhost,127.0.0.1'};
  await writeFile(join(profile,'user.js'),Object.entries(prefs).map(([k,v]) =>
    'user_pref('+JSON.stringify(k)+','+JSON.stringify(v)+');').join('\n'));
  const child = spawn(join(process.env.ProgramFiles,'Mozilla Firefox/firefox.exe'),
    ['-headless','-no-remote','-profile',profile,'--remote-debugging-port','0','about:blank'],
    {stdio:['ignore','pipe','pipe'],windowsHide:true});
  const exited = once(child,'exit');
  let socket;
  try {
    const port = Promise.withResolvers();
    for (const stream of [child.stdout,child.stderr]) stream.on('data', chunk => {
      const match = /BiDi listening on (ws:\/\/127\.0\.0\.1:\d+)/.exec(chunk.toString());
      if (match) port.resolve(match[1]);
    });
    const deadline = AbortSignal.timeout(15000);
    const address = await Promise.race([port.promise,once(deadline,'abort').then(()=>{throw Error('Firefox did not start');}),
      exited.then(()=>{throw Error('Firefox exited during startup');})]);
    for (;;) {
      const attempt = new WebSocket(address+'/session');
      const ready = await new Promise(resolve => {
        attempt.onopen = () => resolve(true); attempt.onerror = () => resolve(false);
      });
      if (ready) { socket = attempt; break; }
      if (deadline.aborted) throw Error('Firefox did not open its WebDriver endpoint');
      await delay(100);
    }
    const waiting = new Map();
    let seq = 0;
    socket.onmessage = ({data}) => {
      const reply = JSON.parse(data), task = waiting.get(reply.id);
      if (!task) return;
      waiting.delete(reply.id);
      if (reply.type==='error') task.reject(Error(reply.message));
      else task.resolve(reply.result);
    };
    function send(method,params={}) {
      const task = Promise.withResolvers(), id = ++seq;
      waiting.set(id,task); socket.send(JSON.stringify({id,method,params})); return task.promise;
    }
    const {capabilities} = await send('session.new',{capabilities:{alwaysMatch:{}}});
    const {contexts:[{context}]} = await send('browsingContext.getTree');
    await send('browsingContext.setViewport',{context,viewport:{width:1440,height:900},devicePixelRatio:1});
    return {version:capabilities.browserVersion,
      preload:source => send('script.addPreloadScript',{functionDeclaration:'() => {'+source+'}'}),
      navigate:url => send('browsingContext.navigate',{context,url,wait:'complete'}),
      async evaluate(expression) {
        const value=await send('script.evaluate',{expression:'(async () => JSON.stringify(await ('+expression+')))()',
          target:{context},awaitPromise:true});
        if (value.type!=='success') throw Error(value.exceptionDetails?.text ?? 'Firefox page evaluation failed');
        return value.result.type === 'undefined' ? undefined : JSON.parse(value.result.value);
      },
      async close() { void send('browser.close').catch(()=>{}); await exited; socket.close(); }};
  } catch (error) {
    socket?.close(); child.kill(); await exited; throw error;
  }
}
