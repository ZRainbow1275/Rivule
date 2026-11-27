// Host-only comparison marker for a sanitized, scoped result. Never authorizes
// a lookup or an operation. Key bytes are environment-owned, never persisted by
// this adapter or returned in a result.
import {createHmac,createSecretKey} from 'node:crypto';
export function makeScopedValidator(key){
 if(!Buffer.isBuffer(key)||key.length<32)throw TypeError('host validator key required');
 const held=createSecretKey(key);
 return (purpose,identity,visible)=>'sv1-'+createHmac('sha256',held)
  .update(JSON.stringify(['rivule-scoped-view-v1',purpose,identity,visible])).digest('base64url');
}
