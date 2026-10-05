// Native Chromium acceptance for #1715. Run explicitly with Node 22:
// node --test src/components/admin/settings-focus.browser.test.mjs
// Actual settings, schedule, confirm and AdminSheet DOM; only the writer
// transport and unrelated Archive surface are fixtures. This is focus/default-
// action proof, not private Auth, server authority or deployment evidence.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

const root = fileURLToPath(new URL('../../../', import.meta.url));
let browser;
let bundle;
const writers = `
const hold = (name, value, apply) => new Promise((resolve, reject) => {
  window.fixture.writes.push({ name, value, apply, resolve, reject });
});
export const setClaimMode = value => hold('claimMode', value, event => ({...event, claimMode:value}));
export const setEventTheme = value => hold('theme', value, event => ({...event, defaultTheme:value}));
export const setDayTheme = (days, index, value) => hold('dayTheme', value, event => ({...event, days:days.map(day => day.index===index ? {...day, theme:value} : day)}));
export const setDayTonight = () => { throw new Error('Unexpected Tonight write'); };
export const unlockDayNow = () => { throw new Error('Unexpected unlock'); };
export const resnapshotDayNow = () => { throw new Error('Unexpected re-snapshot'); };
export const setEasyMixRatio = () => { throw new Error('Unexpected slider write'); };
${[['setPhotoProofSource','photoProofSource'], ['setStripPhotoExif','stripPhotoExif'], ['setVisionGate','visionGate'], ['setReportHideThreshold','reportHideThreshold'], ['setForceAdult','forceAdult']].map(([name,key]) => `export const ${name} = value => hold('${key}', value, event => ({...event, settings:{...event.settings, ${key}:value}}));`).join('\n')}
`;
const entry = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import GameSettings from './src/components/admin/GameSettings';
import SchedulePanel from './src/components/admin/SchedulePanel';
import AdminSheet from './src/components/admin/AdminSheet';
import {setActiveEdition} from './src/editions';
import {setActiveAdultContent} from './src/adultContent';
setActiveEdition('fiveacross'); setActiveAdultContent(true); window.setFixtureAdult=setActiveAdultContent;
const initial = () => ({name:'Fixture', status:'active', claimMode:'honor', defaultTheme:'marquee', settings:{easyMixRatio:0.5, stripPhotoExif:true, visionGate:true, forceAdult:false, reportHideThreshold:4, photoProofSource:'camera_or_library'}, days:[
 {index:0,date:'2026-10-05',place:'Future',placeEmoji:'🎉',pool:'main',theme:'marquee',unlockAt:Date.now()+86400000,tonight:['Show','Party']},
 {index:1,date:'2026-10-04',place:'Past',placeEmoji:'🎉',pool:'main',theme:'marquee',unlockAt:Date.now()-86400000,tonight:['Show','Party'],snapshotItemIds:['present'],snapshotEasyMixRatio:0.5}
]});
function Harness() {
 const [event,setEvent] = useState(initial);
 window.fixture.event=event;
 window.fixture.replace = patch => flushSync(()=>setEvent(previous => ({...previous,...patch})));
 window.fixture.ack = (index=window.fixture.writes.length-1) => {const row=window.fixture.writes[index];flushSync(()=>setEvent(row.apply));row.resolve();};
 window.fixture.reject = (index=window.fixture.writes.length-1) => window.fixture.writes[index].reject(new Error('Fixture denial'));
 return <AdminSheet title="Game settings" onDone={()=>{}}><GameSettings event={event} eventConfirmed={true} pendingClaims={[]} pendingClaimsLoaded={true}/><SchedulePanel days={event.days}/></AdminSheet>;
}
window.fixture={writes:[]};
createRoot(document.getElementById('root')).render(<Harness/>);
`;

before(async () => {
  const output = await build({ stdin:{contents:entry, resolveDir:root, loader:'tsx'}, bundle:true, write:false, format:'iife', jsx:'automatic', define:{'import.meta.env':'{}'}, plugins:[{
    name:'held-writer-transport', setup(builder) {
      builder.onResolve({filter:/^\//,namespace:'fixture'}, args => ({path:args.path,namespace:'file'}));
      builder.onResolve({filter:/data\/admin$/}, () => ({path:'writers',namespace:'fixture'}));
      builder.onResolve({filter:/\.\/ArchiveEvent$/}, () => ({path:'archive',namespace:'fixture'}));
      builder.onResolve({filter:/hooks\/useAdultContent$/}, () => ({path:'adult-hook',namespace:'fixture'}));
      builder.onLoad({filter:/.*/,namespace:'fixture'}, args => ({contents:args.path==='writers'?writers:args.path==='archive'?'export default function Archive(){return null}':`import {adultContentRequired} from ${JSON.stringify(resolve(root,'src/adultContent.ts'))}; export const useAdultContent=adultContentRequired;`, loader:'js'}));
    },
  }] });
  bundle=output.outputFiles[0].text;
  browser=await chromium.launch({headless:true});
});
after(async () => { await browser?.close(); });

async function fixture() {
  const page=await browser.newPage({viewport:{width:375,height:852}});
  await page.route('**/*', route=>route.abort()); // No backend/config/analytics graph.
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({content:await readFile(resolve(root,'src/index.css'),'utf8')});
  await page.addScriptTag({content:bundle});
  await expect(page.getByRole('slider')).toBeVisible();
  return page;
}
async function tabTo(page, control) {
  for(let n=0;n<50;n+=1) {
    if(await control.evaluate(element=>element===document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Control not reachable with Tab');
}
async function mouseClick(page, control) {
  const box=await control.boundingBox(); assert.ok(box);
  await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
}
const writes = page=>page.evaluate(()=>window.fixture.writes.length);
// All focus starts via native Tab. The macOS headless select popup uses
// Playwright's option-selection seam; pending arrows/pointer/default changes
// are still exercised through Chromium, plus a hostile late change callback.
const cases=[
 {name:'claim mode',role:'button',label:'Admin-confirmed',key:'Enter', committed:control=>expect(control).toHaveAttribute('aria-pressed','false')},
 {name:'photo source',role:'button',label:'Camera only',key:'Space', committed:control=>expect(control).toHaveAttribute('aria-pressed','false')},
 {name:'location toggle',role:'checkbox',label:'Strip location data',key:'Space', committed:control=>expect(control).toBeChecked()},
 {name:'AI toggle',role:'checkbox',label:'AI image screen',key:'Space', committed:control=>expect(control).toBeChecked()},
 {name:'adult direct toggle',role:'checkbox',label:'Adults only',key:'Space', committed:control=>expect(control).not.toBeChecked()},
 {name:'threshold',role:'button',label:'Increase auto-hide threshold',key:'Enter', committed:async (control,page)=>expect(control.locator('..').getByText('4',{exact:true})).toBeVisible()},
 {name:'default theme',role:'button',label:/Confetti Hour/,key:'Enter', committed:async (control,page)=>expect(page.getByRole('button',{name:/Marquee/})).toHaveClass(/active/)},
 {name:'Day theme',role:'combobox',label:'Day 1 theme',key:'ArrowDown', committed:control=>expect(control).toHaveValue('marquee')},
];
for(const item of cases) test(`${item.name}: native keyboard focus survives pending, rejection and retry without extra writes`, async () => {
  const page=await fixture();
  try {
    const control=page.getByRole(item.role,{name:item.label,exact:typeof item.label==='string'});
    await tabTo(page,control); await page.keyboard.press(item.key);
    if(item.role==='combobox') {await page.keyboard.press('Escape');await control.selectOption('confetti-hour');}
    await expect.poll(()=>writes(page)).toBe(1);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const pending=await control.evaluate(element=>({focused:document.activeElement===element, disabled:element.disabled, ariaDisabled:element.getAttribute('aria-disabled'), bodyFocused:document.activeElement===document.body}));
    console.log(item.name,JSON.stringify(pending));
    assert.equal(pending.focused,true,'held save must retain native control focus');
    assert.equal(pending.disabled,false); assert.equal(pending.ariaDisabled,'true');
    await item.committed(control,page);
    await expect(page.getByRole('status')).toContainText('saving');
    await page.keyboard.press(item.key); await page.keyboard.press('Enter'); await mouseClick(page,control);
    if(item.role==='combobox') {await page.keyboard.press('ArrowDown');await page.keyboard.press('Home');await page.keyboard.press('g');await page.keyboard.press('Alt+ArrowDown');await page.keyboard.press('Escape');await control.evaluate(element=>{element.value='afterglow';element.dispatchEvent(new Event('change',{bubbles:true}));});}
    assert.equal(await writes(page),1);
    await item.committed(control,page);
    await expect(control).toBeFocused();
    await page.evaluate(()=>window.fixture.reject());
    await expect(page.getByRole('alert')).toContainText('save failed');
    await expect(control).toBeFocused(); await expect(control).toHaveAttribute('aria-disabled','false');
    await page.keyboard.press(item.key);
    if(item.role==='combobox') {await page.keyboard.press('Escape');await control.selectOption('confetti-hour');}
    await expect.poll(()=>writes(page)).toBe(2);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.evaluate(()=>window.fixture.ack());
    await expect(control).toHaveAttribute('aria-disabled','false'); await expect(control).toBeFocused();
    assert.equal(await writes(page),2);
  } finally {await page.close();}
});

test('Day lock, threshold floor and modal cancel/reject ownership remain native safety boundaries', async () => {
 const page=await fixture();
 try {
  await expect(page.getByRole('combobox',{name:'Day 2 theme'})).toHaveJSProperty('disabled',true);
  await page.evaluate(()=>window.fixture.replace({settings:{...window.fixture.event.settings,reportHideThreshold:1}}));
  await expect(page.getByRole('button',{name:'Decrease auto-hide threshold'})).toHaveJSProperty('disabled',true);
  await page.evaluate(()=>window.fixture.replace({settings:{...window.fixture.event.settings,reportHideThreshold:4}}));
  // Enable the real force-adult confirm rather than changing its hook/dialog.
  await page.addScriptTag({content:'window.setFixtureAdult(false)'});
  const toggle=page.getByRole('checkbox',{name:'Adults only'});
  await tabTo(page,toggle); await page.keyboard.press('Space');
  const confirm=page.getByRole('button',{name:'Make this Event 18+'});
  await expect(confirm).toBeVisible(); assert.equal(await writes(page),0);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(confirm).toHaveCount(0); assert.equal(await writes(page),0);
  await toggle.click(); await confirm.click(); await expect.poll(()=>writes(page)).toBe(1);
  await expect(confirm).toHaveJSProperty('disabled',true);
  await page.evaluate(()=>window.fixture.reject());
  await expect(page.getByRole('alert')).toContainText('Nothing changed');
  await expect(confirm).toBeEnabled(); await confirm.click(); await expect.poll(()=>writes(page)).toBe(2);
  await page.evaluate(()=>window.fixture.ack()); await expect(confirm).toHaveCount(0);
 } finally {await page.close();}
});


test('busy Day theme remains in AdminSheet Tab order and a later Day lock remains natively disabled', async () => {
 const page=await fixture();
 try {
  const select=page.getByRole('combobox',{name:'Day 1 theme'});
  await tabTo(page,select); await select.selectOption('confetti-hour');
  await expect(select).toHaveAttribute('aria-disabled','true');
  await page.keyboard.press('Tab'); await expect(page.getByRole('button',{name:'Done',exact:true})).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(select).toBeFocused();
  await page.evaluate(()=>window.fixture.replace({days:window.fixture.event.days.map(day=>day.index===0?{...day,unlockAt:0}:day)}));
  await expect(select).toHaveJSProperty('disabled',true);
  await select.evaluate(element=>{element.value='afterglow';element.dispatchEvent(new Event('change',{bubbles:true}));});
  assert.equal(await writes(page),1); await expect(select).toHaveValue('marquee');
  await page.evaluate(()=>window.fixture.reject()); await expect(select).toHaveJSProperty('disabled',true);
 } finally {await page.close();}
});
