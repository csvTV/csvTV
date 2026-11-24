export type WorkerWrite<Result> = {status:'written'; result:Result} | {status:'unavailable'|'unconfirmed'};
export interface WorkerDatabase {database:string; version:number}

/** No personal rows cross the worker boundary until its connection and the writer are ready. */
export async function runRecordWorker<Operation, Result>(create:()=>Worker, database:WorkerDatabase,
    prepare:()=>Promise<Operation>, closing:AbortSignal, stale:()=>Error, current?:()=>boolean):Promise<WorkerWrite<Result>> {
  if (closing.aborted) throw stale();
  let worker:Worker;
  try { worker = create(); } catch { return {status:'unavailable'}; }
  let state:'starting'|'opening'|'preparing'|'writing'|'settled' = 'starting';
  let close:(()=>void)|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    return await new Promise<WorkerWrite<Result>>((resolve,reject) => {
      function fail(error:unknown) { state = 'settled'; reject(error); }
      function finish(outcome:WorkerWrite<Result>) { state = 'settled'; resolve(outcome); }
      function lostReply() { finish({status:state === 'writing' ? 'unconfirmed' : 'unavailable'}); }
      function expectProgress() { clearTimeout(timer); timer = setTimeout(lostReply,45_000); }
      function reply(type:'cancel'|'admit') {
        try { worker.postMessage({type}); } catch { lostReply(); }
      }
      timer = setTimeout(lostReply,5_000);
      close = () => {
        if (state === 'writing' && current) reply('cancel');
        else if (state !== 'writing' && state !== 'settled') fail(stale());
      };
      closing.addEventListener('abort',close,{once:true});
      worker.onerror = event => { event.preventDefault(); lostReply(); };
      worker.onmessageerror = lostReply;
      worker.onmessage = async event => {
        if (state === 'settled') return;
        const {type,name,result} = (event.data ?? {}) as {type?:string;name?:string;result:Result};
        if (type === 'ready' && state === 'starting') {
          state = 'opening';
          try { worker.postMessage(database); } catch { finish({status:'unavailable'}); }
        } else if (type === 'opened' && state === 'opening') {
          state = 'preparing';
          try {
            const operation = await prepare();
            if (closing.aborted) return fail(stale());
            if (state !== 'preparing') return;
            state = 'writing'; expectProgress();
            try { worker.postMessage(operation); } catch { finish({status:'unavailable'}); }
          } catch (error) { fail(error); }
        } else if (type === 'progress' && state === 'writing') {
          expectProgress();
          if (current && !current()) reply('cancel');
        } else if (type === 'admission' && state === 'writing' && current) {
          expectProgress(); reply(!closing.aborted && current() ? 'admit' : 'cancel');
        } else if (type === 'complete' && state === 'writing') finish({status:'written',result});
        else if (type === 'unavailable' && state !== 'writing') finish({status:'unavailable'});
        else if (type === 'stale') fail(stale());
        else if (type === 'error') fail(new DOMException('The record was not saved.',name ?? 'UnknownError'));
        else lostReply();
      };
    });
  } finally {
    clearTimeout(timer);
    if (close) closing.removeEventListener('abort',close);
    worker.terminate();
  }
}
