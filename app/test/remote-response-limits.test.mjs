import assert from 'node:assert/strict';
import test from 'node:test';
import {DropboxApi} from '../src/dropbox-api.ts';
import {dropboxTransport} from '../src/dropbox-client.ts';
import {checkDropboxFile,dropboxLimits} from '../src/dropbox-limits.ts';
import {MdbListClient} from '../src/mdblist-client.ts';
import {OmdbClient} from '../src/omdb-client.ts';
import {TmdbClient} from '../src/tmdb-client.ts';

const refused = {kind:'too-large'};
const encode = value => new TextEncoder().encode(value);
const request = {endpoint:'download',downloadLimit:8,headers:{Authorization:'Bearer fictional-access'}};

test('Dropbox validates announced and decoded sizes before accepting bytes, including missing or inaccurate length headers',async t=>{
  let send;
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    assert.equal(url,'https://content.dropboxapi.com/2/files/download');
    assert.equal(init.redirect,'error');
    assert.equal(init.credentials,'omit');
    return send();
  });
  for (const headers of [{'Content-Length':'9'}, {'Dropbox-API-Result':'{"size":9}'}]) {
    let canceled=false;
    send=()=>new Response(new ReadableStream({cancel(){canceled=true;}},{highWaterMark:0}),{headers});
    await assert.rejects(dropboxTransport(request),refused);
    assert.equal(canceled,true);
  }
  for (const headers of [{},{'Content-Length':'2','Content-Encoding':'gzip'}]) {
    let reads=0,canceled=false;
    send=()=>new Response(new ReadableStream({pull(c){reads++;c.enqueue(encode('abcd'));},cancel(){canceled=true;}},{highWaterMark:0}),{headers});
    await assert.rejects(dropboxTransport(request),refused);
    assert.equal(reads,3);
    assert.equal(canceled,true);
  }
  send=()=>new Response('12345678',{headers:{'Dropbox-API-Result':'{"size":8}'}});
  assert.equal(new TextDecoder().decode((await dropboxTransport(request)).bytes),'12345678');
  send=()=>new Response('1234',{headers:{'Dropbox-API-Result':'{"size":2}'}});
  await assert.rejects(dropboxTransport(request),{kind:'failed'});
  send=()=>new Response('',{status:429,headers:{'Content-Length':String(dropboxLimits.smallReply+1),'Retry-After':'60'}});
  assert.deepEqual(await dropboxTransport(request),{status:429,bytes:new Uint8Array(),metadata:null,retryAfter:'60'});
});

test('a large upload receipt cannot be read into JS memory or erase evidence of an unanswered conditional upload',async t=>{
  let send;
  t.mock.method(globalThis,'fetch',(_url,init)=>send(init));
  const upload = {endpoint:'upload',body:encode('fictional')};
  for (const declared of [true,false]) {
    let reads=0,canceled=false,signal;
    send=init=>{
      signal=init.signal;
      return new Response(new ReadableStream({
        pull(controller){reads++;controller.enqueue(new Uint8Array(dropboxLimits.smallReply+1));},
        cancel(){canceled=true;},
      },{highWaterMark:0}),{headers:declared?{'Content-Length':String(dropboxLimits.smallReply+1)}:{}});
    };
    await assert.rejects(dropboxTransport(upload),refused);
    assert.equal(signal.aborted,true);
    assert.equal(canceled,true);
    assert.equal(reads,declared?0:1);
  }
});

test('Dropbox listing pages and remote CSV structures are bounded independently of file byte length',async()=>{
  let pages=0;
  const api=new DropboxApi({request:async()=>({status:200,bytes:encode(JSON.stringify({has_more:true,entries:[],cursor:'page-'+(++pages)}))})});
  await assert.rejects(api.list(),refused);
  assert.equal(pages,dropboxLimits.pages);
  const nested={'.tag':'folder',path_display:'/backups/first/nested',name:'nested'};
  const recursiveApi=new DropboxApi({request:async request=>{
    const children=JSON.parse(request.body).recursive ? [nested] : [];
    return {status:200,bytes:encode(JSON.stringify({entries:children,has_more:false}))};
  }});
  assert.equal((await recursiveApi.list('/backups',true))[0].path,nested.path_display);
  await assert.rejects(recursiveApi.list('/unrelated',true),{kind:'failed'});
  const wide=','.repeat(dropboxLimits.csvColumns);
  assert.throws(()=>checkDropboxFile('/watched.csv',wide),refused);
  assert.doesNotThrow(()=>checkDropboxFile('/watched.csv',encode('"'+wide+'\n'+wide+'",2\r\n')));
  assert.throws(()=>checkDropboxFile('/watched.csv',encode('h\r\n'+'v\r\n'.repeat(dropboxLimits.csvRows+1))),refused);
  assert.doesNotThrow(()=>checkDropboxFile('/watched.csv','h\r\n'+'\r\n'.repeat(dropboxLimits.csvRows)));
  assert.throws(()=>checkDropboxFile('/watched.csv','\n'.repeat(dropboxLimits.physicalLines+1)),refused);
  assert.throws(()=>checkDropboxFile('/watched.csv',(','.repeat(127)+'\n').repeat(31_251)),refused);
  let writes=0;
  await assert.rejects(new DropboxApi({request:async()=>{writes++;}}).upload('/watched.csv',wide,{mode:'add'}),refused);
  assert.equal(writes,0);
});

test('normal TMDB, MDBList and OMDb lookups all reject unexpectedly large replies before reading their bodies',async()=>{
  for (const [limit,lookup] of [
    [16,fetch=>new TmdbClient({fetch}).request({kind:'show',id:1},'fictional',{current:()=>true})],
    [1,fetch=>new MdbListClient({fetch}).lookup(1,'fictional',()=>true)],
    [4,fetch=>new OmdbClient({fetch}).lookup('tt0000001',1,'fictional')],
  ]) {
    let canceled=false;
    const fetch=async()=>new Response(new ReadableStream({cancel(){canceled=true;}},{highWaterMark:0}),{headers:{'Content-Length':String(limit*1024*1024+1)}});
    await assert.rejects(lookup(fetch),{kind:'invalid-response'});
    assert.equal(canceled,true);
  }
});
