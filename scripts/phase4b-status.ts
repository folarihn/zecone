// Sanitized local journal status; no signing or payment retry.
import {DatabaseSync} from "node:sqlite";
import {readJson} from "../services/execution/io.ts";
const quote=readJson<{id:string}>(".state/phase4b-live.quote.json");
const db=new DatabaseSync(".state/purchases.sqlite",{readOnly:true});db.exec("PRAGMA busy_timeout=5000");
try {
 const request=db.prepare("SELECT id,stage,order_id,payment_tx FROM purchase_requests WHERE id=?").get(quote.id) as any;
 const order=request?.order_id?db.prepare("SELECT state,tx_hash,observed_at FROM orders WHERE id=?").get(request.order_id):null;
 const scanRow=request?.order_id?db.prepare("SELECT detail FROM audit WHERE order_id=? AND event='scan_verified' ORDER BY seq DESC LIMIT 1").get(request.order_id) as {detail:string}|undefined:undefined;
 const scan=scanRow?JSON.parse(scanRow.detail):null;
 const notes=request?.order_id?db.prepare("SELECT height,active,confirmed FROM payments WHERE order_id=?").all(request.order_id) as any[]:[];
 console.log(JSON.stringify({at:new Date().toISOString(),...request,...order,scannedTip:scan?.tip,confirmations:notes.map(n=>({count:scan?scan.tip-n.height+1:0,active:n.active,confirmed:n.confirmed})),recoveries:request?.order_id?db.prepare("SELECT reason,status FROM recoveries WHERE order_id=?").all(request.order_id):[]}));
}finally{db.close();}
