import {findCastMember,type CachedCastMember} from './cast-cache.ts';
import {serveCacheLookup} from './read-worker-server.ts';

interface Request {database:string;version:number;person:number;now:number}
serveCacheLookup<Request,CachedCastMember|null>('tmdb',(tx,{person,now},progress) => {
  let member:CachedCastMember|null = null;
  findCastMember(tx.objectStore('tmdb'),person,now,value=>{member=value ?? null;},Infinity,progress);
  return () => member;
});
