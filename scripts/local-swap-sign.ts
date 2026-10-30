// User key is read only in this local signer, never by the provider adapter.
import { resolve,relative,isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import { getAddress,keccak256,toHex } from "viem";
import { readJson,exclusiveJson,loadAccount } from "../services/execution/io.ts";
import { terms,swapTyped,type SwapConfig,type UnsignedSwap,type SwapIntent } from "../services/swaps/intent.ts";
import { quoted } from "../services/swaps/adapter.ts";
async function main(){
 const file=resolve(process.argv[2]??""),inside=relative(resolve(".state/swap-approvals"),file);
 if(inside.startsWith("..")||isAbsolute(inside)||!inside.endsWith(".json"))throw Error("approval_path");
 const a=readJson<{approved:boolean;expires:number;intent:UnsignedSwap}>(file);
 if(!a.approved||a.expires<=Date.now())throw Error("expired_approval");
 const c=readJson<SwapConfig>(".state/swap-84532-confirmed.json"),user=loadAccount(".secrets/user/base-sepolia.json");
 if(getAddress(c.user)!==user.address)throw Error("wrong_user");
 const manifest=readJson<{zcash:{payer:{address:string}}}>("docs/PUBLIC_WALLETS.json");
 if(a.intent.refundHash!==keccak256(toHex(manifest.zcash.payer.address)))throw Error("wrong_refund");
 terms(a.intent,c,Math.floor(Date.now()/1000));
 if((await quoted(c,BigInt(a.intent.maxNative))).expectedOut<BigInt(a.intent.minOut))throw Error("slippage_exceeded");
 const out=file.replace(/\.json$/,".signed.json");
 if(existsSync(out)){const {signature,...old}=readJson<SwapIntent>(out);if(JSON.stringify(old)!==JSON.stringify(a.intent))throw Error("approval_conflict");}
 else exclusiveJson(out,{...a.intent,signature:await user.signTypedData(swapTyped(a.intent))});
 console.log(JSON.stringify({intentFile:out}));
}
main().catch(()=>{console.error("Local swap approval failed; no success is assumed.");process.exitCode=1;});
