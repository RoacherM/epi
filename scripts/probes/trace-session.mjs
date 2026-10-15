// Offline Epi SDK probe: in-memory append ordering at message_end/turn_end; recorded schemas.
// Uses --no-session: this does not test filesystem durability or restart recovery.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=mkdtempSync(join(tmpdir(),'epi-trace-session-'));
const oldCwd=process.cwd();
let runtime;
try {
  process.env.HOME=join(root,'home');
  process.env.EPI_HOME=join(root,'home','.epi');
  process.env.EPI_OFFLINE='1';
  mkdirSync(process.env.EPI_HOME,{recursive:true});
  const project=join(root,'project'); mkdirSync(project); process.chdir(project);
  writeFileSync(join(process.env.EPI_HOME,'epi.json'),JSON.stringify({version:1,
    extensions:[fileURLToPath(new URL('../../test/fixtures/faux-edit-tool.mjs',import.meta.url))],
    disable:['epi:task','epi:mcp','epi:hooks']}));
  await import('../../dist/isolate-pi-env.js');
  const {prepareEpiRun}=await import('../../dist/host.js');
  const {createRuntimeFromPrepared}=await import('../../dist/tui/start.js');
  const {getCurrentTools}=await import('@earendil-works/pi-ai');
  const prepared=prepareEpiRun(['--no-project','--no-session','--model','epi-faux/editor']);
  runtime=await createRuntimeFromPrepared(prepared,project);
  const session=runtime.session;
  const observations=[];
  session.subscribe(e=>{
    if(e.type==='message_end'||e.type==='turn_end') {
      const entries=session.sessionManager.getBranch();
      const message=e.message;
      const found=entries.some(x=>x.type==='message'&&x.message===message);
      observations.push({type:e.type,role:message.role,appended:found});
    }
  });
  await session.prompt('change things');
  const msgEnds=observations.filter(e=>e.type==='message_end');
  const turnEnds=observations.filter(e=>e.type==='turn_end');
  assert.ok(msgEnds.length>0&&msgEnds.every(e=>!e.appended));
  assert.ok(turnEnds.length>0&&turnEnds.every(e=>e.appended));
  const entries=session.sessionManager.getBranch();
  const schemas=getCurrentTools(entries.filter(e=>e.type==='message').map(e=>e.message));
  assert.ok(schemas.find(t=>t.name==='edit')?.parameters);
  assert.ok(schemas.find(t=>t.name==='write')?.parameters);
  console.log(JSON.stringify({checks:'Epi runtime message_end before append; turn_end after append; tool schemas recorded: PASS',observations,
    recordedSchemas:schemas.map(t=>t.name)},null,2));
} finally {
  if(runtime) { await runtime.session.dispose(); }
  process.chdir(oldCwd); rmSync(root,{recursive:true,force:true});
}
