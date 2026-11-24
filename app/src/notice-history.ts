import { noticeLimit, type NoticeEntry, type DeviceStore } from './storage.ts';

/** Keep reader-tab and unsaved reports visible even if local storage is full. */
export function createNoticeHistory(store:DeviceStore, owner:()=>string|null) {
  const updates = new EventTarget();
  let recent:NoticeEntry[] = [];
  let pending:{account:string|null; entries:NoticeEntry[]}|undefined;
  function add(message:string) {
    const entry = {id:crypto.randomUUID(),time:Date.now(),message:message.length > 2048 ? message.slice(0,2047) + '…' : message};
    recent = [entry,...recent].slice(0,noticeLimit);
    const account = store.role === 'writer' ? owner() : null;
    if (!pending || pending.account !== account) {
      const batch = {account,entries:[] as NoticeEntry[]};
      pending = batch;
      // One sync can report many rows before it yields. Save and redraw that burst once.
      queueMicrotask(()=>{
        if (pending !== batch) return;
        pending = undefined;
        if (account && owner() === account && store.role === 'writer') void store.saveNotices(account,batch.entries).catch(()=>{});
        updates.dispatchEvent(new Event('change'));
      });
    }
    pending.entries.unshift(entry);
    if (pending.entries.length > noticeLimit) pending.entries.pop();
  }
  function mount(content:HTMLElement) {
    const doc = content.ownerDocument;
    const panel = doc.createElement('details');
    panel.className = 'group notification-log';
    panel.innerHTML = '<summary>Notification log</summary><p>No notifications yet.</p><ul></ul>';
    const list = panel.querySelector('ul')!, empty = panel.querySelector('p')!;
    const format = new Intl.DateTimeFormat(undefined,{dateStyle:'short',timeStyle:'short'});
    let revision = 0;
    async function draw() {
      const run = ++revision, account = owner();
      if (!panel.open) return;
      const saved = account ? await store.noticeHistory(account).catch(()=>[]) : [];
      if (!panel.open || run !== revision || owner() !== account) return;
      const seen = new Set<string>();
      const rows = [...recent,...saved].sort((a,b)=>b.time-a.time).filter(entry=>{
        if (seen.has(entry.id)) return false;
        seen.add(entry.id); return true;
      }).slice(0,noticeLimit);
      empty.hidden = rows.length > 0;
      list.hidden = !rows.length;
      list.replaceChildren(...rows.map(row=>{
        const item = doc.createElement('li'), time = doc.createElement('time'), text = doc.createElement('span');
        time.dateTime = new Date(row.time).toISOString();
        time.textContent = format.format(row.time);
        text.textContent = row.message;
        item.append(time,text); return item;
      }));
    }
    panel.addEventListener('toggle',draw);
    updates.addEventListener('change',draw);
    store.addEventListener('noticehistorychange',draw);
    content.append(panel);
    return () => {
      revision++;
      panel.removeEventListener('toggle',draw);
      updates.removeEventListener('change',draw);
      store.removeEventListener('noticehistorychange',draw);
    };
  }
  function addGroup(messages:readonly string[]) {
    for (const message of messages.slice(-noticeLimit)) add(message);
  }
  return {add,addGroup,mount,reset() { pending = undefined; recent = []; updates.dispatchEvent(new Event('change')); }};
}
