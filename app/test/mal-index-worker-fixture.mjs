export function malWorkerFixture(req,res) {
  if (req.url==='/fictional-mal-inspect.js') {
    res.writeHead(200,{'content-type':'text/javascript'}).end(`
      let first; self.onmessage=event=>{first=event;};
      const audit={transaction:'',source:0,rows:0,unexpected:0};
      const transaction=IDBDatabase.prototype.transaction, get=IDBObjectStore.prototype.get, send=self.postMessage.bind(self);
      IDBDatabase.prototype.transaction=function(stores,mode,...rest){
        audit.transaction=String(stores);if(mode && mode!=='readonly')audit.unexpected++;
        return transaction.call(this,stores,mode,...rest);};
      IDBObjectStore.prototype.get=function(key){
        if(this.name==='settings' && key==='mal_source')audit.source++;
        else if(this.name==='cache' && Array.isArray(key) && key[0]==='mal' && key[1]==='show')audit.rows++;
        else audit.unexpected++;
        return get.apply(this,arguments);};
      self.postMessage=message=>send('result' in message?{...message,audit}:message);
      await import('/tracker/mal-lookup-worker.js'); if(first)self.onmessage(first);`);
    return true;
  }
  if (req.url==='/fictional-mal-quota.js') {
    res.writeHead(200,{'content-type':'text/javascript'}).end(`
      const put=IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put=function(value,key){
        if(this.name==='cache' && key[1]==='show' && key[2]===17+500*11)throw new DOMException('Fictional cache limit','QuotaExceededError');
        return put.apply(this,arguments);};
      await import('/tracker/github-index-worker.js');`);
    return true;
  }
  return false;
}
