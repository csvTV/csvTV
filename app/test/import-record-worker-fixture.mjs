// Replace one native operation in the test worker and then run the shipped module unchanged.
export function importWorkerFixture(request,response) {
  if (!['/fictional-cache-quota.js','/fictional-constraint.js','/fictional-worker-expiry.js'].includes(request.url)) return false;
  const inject = request.url==='/fictional-cache-quota.js' ? `
    const put=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(...args) {
      if(this.name==='tmdb')throw new DOMException('Fictional quota reached','QuotaExceededError');
      return put.apply(this,args);
    };` : request.url==='/fictional-constraint.js' ? `
    const put=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(value,...args) {
      const request=put.call(this,value,...args);
      if(this.name==='settings' && value.setting==='recently_marked.72.3.0.0')this.add(value);
      return request;
    };` : `
    const send=self.postMessage.bind(self),now=Date.now;
    self.postMessage=(message,...rest)=>{
      if(message.type==='progress')Date.now=()=>now()+2*86400000;
      return send(message,...rest);
    };`;
  response.writeHead(200,{'content-type':'text/javascript'}).end(inject+"\nawait import('/tracker/import-record-worker.js');");
  return true;
}
