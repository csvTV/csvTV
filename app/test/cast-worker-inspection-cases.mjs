// Inspect the actual worker's own IndexedDB calls; the page's prototypes are separate.
const transaction = IDBDatabase.prototype.transaction, get = IDBObjectStore.prototype.get;
const report = {tables:[],reads:0,unexpected:0};
IDBDatabase.prototype.transaction = function(names,mode,...rest) {
  report.tables.push([names,mode ?? 'readonly']);
  return transaction.call(this,names,mode,...rest);
};
IDBObjectStore.prototype.get = function(key) {
  report.reads++;
  if (this.name!=='tmdb' || typeof key!=='string' || !/^tv\/\d+\/aggregate_credits$/.test(key)) report.unexpected++;
  return get.call(this,key);
};
const post = self.postMessage.bind(self);
self.postMessage = value => post('result' in value ? {...value,inspection:report} : value);
let first;
self.onmessage = event => { first=event; };
await import('../dist/cast-lookup-worker.js');
if(first)self.onmessage(first);
