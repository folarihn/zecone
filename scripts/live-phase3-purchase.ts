// Explicitly authorized one-purchase browser demonstration; never run as a test.
import {chromium,expect} from '@playwright/test';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {exclusiveJson,readJson} from '../services/execution/io.ts';
import {PurchaseBase,type MarketConfig} from '../services/marketplace/purchase.ts';
const marker='.state/phase3-live-started.json',evidence='docs/phase3-evidence';
if(!process.argv.includes('--allow-testnet-spend'))throw Error('Explicit live testnet spend flag required');
if(existsSync(marker))throw Error('A Phase 3 live attempt already exists. Reconcile it; do not start another.');
const c=readJson<MarketConfig&{seller:`0x${string}`;user:`0x${string}`}>('.state/marketplace-confirmed.json'),b=new PurchaseBase(c);await b.check();
const state:any={startedAt:new Date().toISOString(),paymentApprovalStarted:false,scope:'One purchase of listing 1 for 0.01 TAZ plus explicitly reviewed native fee',balancesBefore:{provider:(await b.public.getBalance({address:b.account.address})).toString(),seller:(await b.public.getBalance({address:c.seller})).toString(),user:(await b.public.getBalance({address:c.user})).toString()}};
exclusiveJson(marker,state);mkdirSync(evidence,{recursive:true});const save=()=>writeFileSync(marker,JSON.stringify(state,null,2),{mode:0o600});
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const context=await browser.newContext({storageState:'.secrets/phase3-browser-session.json',viewport:{width:1440,height:1050}}),market=await context.newPage();await market.goto(c.origin);
 await expect(market.locator('.card')).toHaveCount(3,{timeout:60000});const popupPromise=context.waitForEvent('page');await market.getByRole('button',{name:'Connect ZecOne',exact:true}).click();const popup=await popupPromise;await popup.waitForLoadState();
 const connect=popup.getByRole('button',{name:'Approve request',exact:true});await expect(connect).toBeVisible({timeout:30000});await expect(popup.locator('.origin-box')).toContainText(c.origin);await popup.screenshot({path:`${evidence}/origin-approval.png`,fullPage:true});await connect.click();
 await expect(market.locator('#account')).toContainText(c.user,{timeout:30000});await market.screenshot({path:`${evidence}/marketplace-before.png`,fullPage:true});
 await market.locator('.card').first().getByRole('button',{name:'Pay with shielded ZEC'}).click();await expect(popup.getByRole('heading',{name:'Review marketplace quote'})).toBeVisible({timeout:60000});await expect(popup.getByRole('dialog')).toContainText('1000000');await expect(popup.getByRole('dialog')).toContainText(c.user);await popup.screenshot({path:`${evidence}/quote-approval.png`,fullPage:true});await popup.getByRole('button',{name:'Approve purchase quote',exact:true}).click();
 await expect(popup.getByRole('button',{name:'Review Zcash fee'})).toBeVisible({timeout:120000});state.purchaseId=await market.evaluate(()=>localStorage.getItem('zecone:purchase'));if(!state.purchaseId)throw Error('Missing durable purchase reference');save();
 await popup.getByRole('button',{name:'Review Zcash fee'}).click();await expect(popup.getByRole('heading',{name:'Authorize shielded payment'})).toBeVisible({timeout:120000});const text=await popup.getByRole('dialog').innerText();if(!text.includes('0.01 TAZ')||!text.includes('Maximum Zcash fee')||!text.includes(c.user))throw Error('Unexpected payment review');await popup.screenshot({path:`${evidence}/payment-approval.png`,fullPage:true});
 state.paymentApprovalStarted=true;state.paymentReview=text;save();await popup.getByRole('button',{name:'Approve & pay test ZEC',exact:true}).click();await expect(popup.getByRole('dialog')).not.toBeVisible({timeout:90000});state.paymentRequested=true;save();
 writeFileSync(`${evidence}/browser-start.json`,JSON.stringify({startedAt:state.startedAt,purchaseId:state.purchaseId,origin:c.origin,listingId:'1',user:c.user,paymentRequested:true,notice:'Approval requested; confirmation and settlement must be verified separately.'},null,2));console.log(JSON.stringify({purchaseId:state.purchaseId,paymentRequested:true,notice:'Awaiting native send and real chain confirmations.'}));
}catch(e){writeFileSync('.state/phase3-browser-error.txt',e instanceof Error?e.message:'Unknown browser failure');console.error('Live browser attempt stopped. Preserve its marker and saved purchase; inspect before recovery.');process.exitCode=1;}finally{await browser.close();}
