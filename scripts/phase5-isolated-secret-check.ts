// Compare newly generated private test material against publishable files in memory.
import {readFileSync,readdirSync,existsSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {decrypt} from "../services/signer/keystore.ts";
const values:Buffer[]=[];
async function scan(dir:string){if(!existsSync(dir))return;for(const entry of readdirSync(dir,{withFileTypes:true})){
 const p=join(dir,entry.name);if(entry.isDirectory())await scan(p);
 else if(entry.isFile()&&entry.name==="development-password.bin"){
  const password=readFileSync(p);values.push(password,Buffer.from(password.toString("hex")),Buffer.from(password.toString("base64")));
  for(const file of readdirSync(dir).filter(n=>n.endsWith("keystore.json"))){const envelope=JSON.parse(readFileSync(join(dir,file),"utf8")),secret=await decrypt(envelope,password,envelope.purpose);values.push(secret,Buffer.from(secret.toString("hex")),Buffer.from(secret.toString("base64")));}
 }else if(entry.isFile()&&entry.name==="viewing-key.txt")values.push(readFileSync(p));
}}
try{
 for(const dir of [".secrets/phase5-watch",".secrets/phase5-refund-validation",".secrets/phase5-portable"])await scan(dir);
 const paths=[...new Set([...execFileSync("git",["diff","--name-only","HEAD"],{encoding:"utf8"}).trim().split(/\r?\n/),...execFileSync("git",["ls-files","--others","--exclude-standard"],{encoding:"utf8"}).trim().split(/\r?\n/)])].filter(p=>p&&existsSync(p));
 const exposed=paths.filter(p=>{const data=readFileSync(p);return values.some(v=>data.includes(v));});
 const report={at:new Date().toISOString(),filesChecked:paths.length,isolatedSecretPatternsChecked:values.length,exposedFiles:exposed,scope:"New disposable credentials only; values compared in memory, never logged"};
 writeFileSync("docs/phase5-evidence/completion-isolated-secret-check.json",JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report));if(exposed.length)process.exitCode=1;
}finally{values.forEach(v=>v.fill(0));}
