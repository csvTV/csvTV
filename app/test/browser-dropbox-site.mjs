import {createServer} from 'node:http';
import {releaseServer} from './release-site.mjs';

export function releaseWithDropbox(assets, getProvider) {
  const serveFiles = releaseServer(assets).listeners('request')[0];
  return createServer(async (request,response) => {
    if (!request.url.startsWith('/fictional-dropbox/')) return serveFiles(request,response);
    const provider = getProvider(), url = 'https://' + request.url.slice('/fictional-dropbox/'.length);
    provider.seen ??= [];
    provider.seen.push(request.method + ' ' + new URL(url).pathname);
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = Buffer.concat(chunks);
      await provider.respond({requestId:'webkit',request:{url,method:request.method,headers:request.headers,
        postData:payload.toString(),postDataEntries:[{bytes:payload.toString('base64')}]}},
      async (command, reply) => {
        if (command === 'Fetch.failRequest') { response.destroy(); return; }
        response.writeHead(reply.responseCode,Object.fromEntries(reply.responseHeaders.map(({name,value})=>[name,value])))
          .end(Buffer.from(reply.body,'base64'));
      });
    } catch {
      // Closing an isolated tab can interrupt its request body before the provider receives it.
      if (!response.destroyed) response.writeHead(500).end();
    }
  });
}

export async function connectFictionalDropbox(context) {
  // WebKit's proxy can refuse an HTTPS CONNECT before Playwright sees the request.
  // Retain native fetch, pointing just the two Dropbox hosts at the fixture.
  await context.addInitScript(() => {
    function dropboxFixture(target) {
      const url = new URL(target,location.href);
      return url.protocol === 'https:' && ['api.dropboxapi.com','content.dropboxapi.com'].includes(url.host)
        ? '/fictional-dropbox/'+url.host+url.pathname+url.search : null;
    }
    const fetch = window.fetch.bind(window);
    window.fetch = (target,init) => fetch(dropboxFixture(target instanceof Request ? target.url : target) ?? target,init);
  });
}
