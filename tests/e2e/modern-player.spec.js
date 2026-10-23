import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { writeStory } from '../../packages/export-story/index.js';
import * as io from '../../packages/cli/io.js';
import { publishWeb, publishScorm12 } from '../../packages/publisher/index.js';
import { createServer as serveStatic } from '../../packages/lms-test-harness/serve.js';
import { createServer as serveEditor } from '../../packages/server/server.js';
let root, staticServer, editor, url, editorUrl;
const token='modern-player-local-test';
test.beforeAll(async()=>{
 root=fs.mkdtempSync(path.join(os.tmpdir(),'cf-modern-'));
 const file=path.join(root,'modern.story');fs.writeFileSync(file,writeStory({title:'Modern test',text:'Modern course'}));
 const doc=io.loadCourse(file);
 publishWeb(doc,path.join(root,'web'));
 publishScorm12(doc,path.join(root,'scorm'));
 staticServer=serveStatic(root);staticServer.listen(0,'127.0.0.1');await once(staticServer,'listening');url=`http://127.0.0.1:${staticServer.address().port}`;
 editor=serveEditor({root,token,port:0});await once(editor,'listening');editorUrl=`http://127.0.0.1:${editor.address().port}`;
});
test.afterAll(async()=>{for(const s of [staticServer,editor]){s.closeAllConnections();await new Promise(r=>s.close(r));}});
test.beforeEach(async({context})=>{await context.route(url=>/^https?:$/.test(url.protocol)&&url.hostname!=='127.0.0.1',r=>r.abort());});
for(const width of [1440,375]) test(`modern Web/SCORM presentation at ${width}`,async({page})=>{
 await page.setViewportSize({width,height:850});
 for(const output of ['web','scorm']){
  await page.goto(url+'/'+output+'/index.html');
  if (await page.getByRole('button',{name:'Restart',exact:true}).isVisible()) await page.getByRole('button',{name:'Restart',exact:true}).click();
  await expect(page.getByText('Modern course',{exact:true})).toBeVisible();
  await expect(page.locator('.cf-bar')).toHaveCSS('background-color','rgb(42, 46, 53)');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }
});
test('editor player selection saves through shared command and survives native reopen',async({page})=>{
 await page.goto(editorUrl+'/?token='+token+'#modern');
 await page.getByRole('tab',{name:'Course',exact:true}).click();
 await expect(page.getByLabel('Player style',{exact:true})).toHaveValue('modern');
 await page.getByLabel('Player style',{exact:true}).selectOption('classic');
 await expect.poll(()=>io.loadCourse(path.join(root,'modern.story')).player.style).toBe('classic');
 await page.getByLabel('Player style',{exact:true}).selectOption('modern');
 await expect.poll(()=>io.loadCourse(path.join(root,'modern.story')).player.style).toBe('modern');
});
