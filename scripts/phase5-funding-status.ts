// Read-only reconciliation. Never clears markers, reconstructs or broadcasts.
import {readFileSync,existsSync,writeFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {join} from "node:path";
import {WatchOnlyZcash} from "../services/signer/watch-evidence.ts";
async function main(){
 const request=JSON.parse(readFileSync(".state/phase5-first-wallet-funding.json","utf8"));
 const config=JSON.parse(readFileSync(".state/phase5-refund-validation.json","utf8")),payer=config.roles.find((r:any)=>r.role==="payer");
 const db=new DatabaseSync(".secrets/user/zcash/wallet.sqlite",{readOnly:true});
 const matches=db.prepare("SELECT t.txid,t.mined_height,length(t.raw) raw_bytes FROM sent_notes s JOIN transactions t ON t.id_tx=s.transaction_id WHERE s.to_address=? AND s.value=?").all(request.recipient,Number(request.zatoshis));db.close();
 const source=".secrets/user/zcash",saved=existsSync(join(source,`request-${request.requestId}.json`)),started=existsSync(join(source,`request-${request.requestId}.started.json`));
 const snap=await new WatchOnlyZcash(payer.watch).observe();
 const receipts=snap.payments.map(p=>({txid:p.txid,zatoshis:p.zatoshis,height:p.height,confirmations:snap.tip-p.height+1}));
 const report={at:new Date().toISOString(),network:"zcash-testnet",requestId:request.requestId,requestedZatoshis:request.zatoshis,feeCapZatoshis:request.maxFeeZatoshis,
   savedTransactionReferencePresent:saved,constructionMarkerPresent:started,sourceProcessLockPresent:existsSync(join(source,"process.lock")),matchingSourceTransactions:matches.length,
   payerScan:{tip:snap.tip,scanned:snap.scanned,blockHash:snap.blockHash,receipts},
   outcome:!saved&&started?"construction_interrupted_requires_manual_reconciliation":"inspect_saved_transaction_and_receipts",
   retryAttempted:false,markersChanged:false,refundSigned:false,refundBroadcast:false};
 writeFileSync("docs/phase5-evidence/completion-funding-reconciliation.json",JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report,null,2));
}
main().catch(()=>{console.error("read_only_funding_reconciliation_failed");process.exitCode=1;});
