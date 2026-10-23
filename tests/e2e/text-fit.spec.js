import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { importStory } from '../../packages/import-story/index.js';
import { publishWeb } from '../../packages/publisher/index.js';
import { createServer } from '../../packages/server/server.js';
import { saveCourse } from '../../packages/cli/io.js';
import { obj, slide, pkg, esc } from '../fixtures/synthetic/story-builder.js';

test('editor and player shrink measured rich content, preserve wrapping and never enlarge short text', async ({page}) => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cf-text-fit-')); let server;
  try {
    const shapes = [obj('textBox',201,{at:[20,20,320,70],attrs:'autoFit="shrink" wrap="true"',extra:'<bounds l="10" t="5" r="290" b="45"/><text>'+esc('<Document><Content><Block><Span Text="A synthetic title with "><Style FontSize="30"/></Span><Span Text="smaller rich words requiring a measured fit"><Style FontSize="15"/></Span></Block></Content></Document>')+'</text>'}),
      obj('textBox',202,{at:[20,100,320,180],text:'Short',attrs:'autoFit="shrink" wrap="true"',extra:'<bounds l="10" t="5" r="290" b="75"/>'})].join('');
    const {doc}=importStory(pkg({parts:[slide(101,{shapes})]}));
    saveCourse(path.join(dir,'fit.course.json'),doc); publishWeb(doc,path.join(dir,'web'),{courseDir:dir});
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    const measure=async selector=>page.locator(selector).evaluate(el=>{
      const c=el.firstElementChild, spans=[...c.querySelectorAll('span[style]')];
      return {scale:Number(c.dataset.textFitScale),width:c.scrollWidth,height:c.scrollHeight,wrap:getComputedStyle(c).whiteSpace,sizes:spans.map(n=>parseFloat(n.style.fontSize)),nominal:parseFloat(getComputedStyle(el).fontSize)};
    });
    await page.goto(pathToFileURL(path.join(dir,'web/index.html')).href);
    const p=await measure('[data-id="o-000002011111"]');
    expect(p.scale).toBeGreaterThan(0); expect(p.scale).toBeLessThan(1); expect(p.height).toBeLessThanOrEqual(40); expect(p.width).toBeLessThanOrEqual(280);
    expect(p.wrap).toBe('pre-wrap'); expect(p.sizes[0]/p.sizes[1]).toBeCloseTo(2); expect(p.nominal).toBe(16);
    expect((await measure('[data-id="o-000002021111"]')).scale).toBe(1);
    server=createServer({root:dir,token:'text-fit-test',port:0}); await once(server,'listening');
    await page.goto(`http://127.0.0.1:${server.address().port}/?token=text-fit-test#fit`);
    await expect(page.locator('#obj-o-000002011111')).toBeVisible();
    const e=await measure('#obj-o-000002011111'); expect(e.scale).toBeLessThan(1); expect(e.height).toBeLessThanOrEqual(40); expect(e.sizes[0]/e.sizes[1]).toBeCloseTo(2);
    expect((await measure('#obj-o-000002021111')).scale).toBe(1); expect(errors).toEqual([]);
  } finally { if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));} fs.rmSync(dir,{recursive:true,force:true}); }
});
