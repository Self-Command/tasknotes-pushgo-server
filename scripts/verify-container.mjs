import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import sharp from 'sharp';
const base=process.env.VERIFY_URL??'http://localhost:8787';
const password=(await readFile('secrets/owner_password','utf8')).trim();
const login=await fetch(base+'/tasknotes/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password,client:'plugin'})});assert.equal(login.status,200);const {token}=await login.json();
async function api(path,body,method=body===undefined?'GET':'POST'){const r=await fetch(base+'/tasknotes/v1'+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});assert.equal(r.status,200,path);return r.json();}
if(process.argv[2]==='seed'){
 const settings=await api('/settings');await api('/settings',{...settings,reportsEnabled:false},'PUT');
 const operation={operationId:randomUUID(),taskId:randomUUID(),baseVersion:0,action:'create',origin:'tasknotes_ui',changes:{title:'容器持久化验收',scheduled:new Date(Date.now()+300000).toISOString(),due:new Date(Date.now()+540000).toISOString()}};
 const t=await api('/workspaces/owner/mutations',operation);assert.equal((await api('/workspaces/owner/mutations',operation)).version,t.version);
 const {uploadId}=await api('/instances/'+t.id+'/uploads',{kind:'end',version:t.version});const image=await sharp({create:{width:16,height:16,channels:3,background:'blue'}}).png().toBuffer();
 const upload=await fetch(base+'/tasknotes/v1/uploads/'+uploadId,{method:'PUT',headers:{Authorization:'Bearer '+token,'Content-Type':'application/octet-stream'},body:image});assert.equal(upload.status,200);
 const checkin=await api('/instances/'+t.id+'/checkins/end',{version:t.version,uploadId,submitId:randomUUID(),note:'容器照片恢复验证'});
 await writeFile('../.hms-tools/tasknotes-container-state.json',JSON.stringify({taskId:t.id,mediaId:uploadId,checkinId:checkin.id}));
 console.log('PASS: container login, durable task idempotency, photo upload and independent end check-in');
}else{
 const state=JSON.parse(await readFile('../.hms-tools/tasknotes-container-state.json','utf8'));
 const t=await api('/instances/'+state.taskId);assert.ok(t.checkins.some(c=>c.id===state.checkinId));
 const photo=await fetch(base+'/tasknotes/v1/media/'+state.mediaId,{headers:{Authorization:'Bearer '+token}});assert.equal(photo.status,200);assert.ok((await photo.arrayBuffer()).byteLength>0);
 console.log('PASS: persisted task, check-in and private photo restored');
}
